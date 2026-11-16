// A small GraphQL engine for the forge's fixed surface: a lexer, a
// recursive-descent parser and an executor over the shared store. It
// covers the operations the conformance suite sends (queries, mutations,
// variables, aliases, inline fragments, input objects, batching) plus
// the __type introspection those checks rely on. GraphQL-level failures
// are HTTP 200 with an `errors` array, never an HTTP error.

import {
  Forge,
  DEFAULT_BRANCH,
  type CommentRecord,
  type IssueRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { parseGlobalId } from './util.ts';
import { VIEWER, userByLogin, type ScenarioUser } from './scenario.ts';

// -------------------------------------------------------------------- lexer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'eof' };

/** A syntax error in the query document. */
class GraphQLSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLSyntaxError';
  }
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ' ') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '.' && source.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(index, index + 3) === '"""') {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new GraphQLSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(index + 3, end).replace(/\\"""/g, '"""') });
        index = end + 3;
        continue;
      }
      let end = index + 1;
      let value = '';
      let closed = false;
      while (end < source.length) {
        const c = source[end] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\n' || c === '\r') throw new GraphQLSyntaxError('unterminated string');
        if (c === '\\') {
          const escape = source[end + 1];
          if (escape === undefined) throw new GraphQLSyntaxError('unterminated escape');
          const simple: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (escape === 'u') {
            const hex = source.slice(end + 2, end + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLSyntaxError('bad unicode escape');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            end += 6;
          } else if (simple[escape] !== undefined) {
            value += simple[escape];
            end += 2;
          } else {
            throw new GraphQLSyntaxError(`bad escape \\${escape}`);
          }
          continue;
        }
        value += c;
        end += 1;
      }
      if (!closed) throw new GraphQLSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value });
      index = end + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (match === null) throw new GraphQLSyntaxError(`bad number at offset ${index}`);
      const text = match[0];
      tokens.push(
        match[1] !== undefined || match[2] !== undefined
          ? { kind: 'float', value: text }
          : { kind: 'int', value: text },
      );
      index += text.length;
      continue;
    }
    if (isNameStart(ch)) {
      let end = index + 1;
      while (end < source.length && isNameChar(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new GraphQLSyntaxError(`unexpected character ${JSON.stringify(ch)} at offset ${index}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: { name: string; defaultValue: ValueNode | null }[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.position] as Token;
  }

  private advance(): Token {
    const token = this.tokens[this.position] as Token;
    if (token.kind !== 'eof') this.position += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.advance();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`expected ${JSON.stringify(value)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.advance();
    if (token.kind !== 'name') throw new GraphQLSyntaxError('expected a name');
    return token.value;
  }

  private acceptName(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'name' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return {
        kind: 'operation',
        operation: 'query',
        name: null,
        variableDefinitions: [],
        selections: this.parseSelectionSet(),
      };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.advance();
      const name = this.expectName();
      if (!this.acceptName('on')) throw new GraphQLSyntaxError('fragment needs an "on" type condition');
      const typeCondition = this.expectName();
      this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = token.value as 'query' | 'mutation' | 'subscription';
      this.advance();
      let name: string | null = null;
      const next = this.peek();
      if (next.kind === 'name') name = this.expectName();
      const variableDefinitions = this.parseVariableDefinitions();
      this.parseDirectives();
      return { kind: 'operation', operation, name, variableDefinitions, selections: this.parseSelectionSet() };
    }
    throw new GraphQLSyntaxError('expected an operation or fragment definition');
  }

  private parseVariableDefinitions(): { name: string; defaultValue: ValueNode | null }[] {
    const definitions: { name: string; defaultValue: ValueNode | null }[] = [];
    if (!this.acceptPunct('(')) return definitions;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      this.parseDirectives();
      definitions.push({ name, defaultValue });
    }
    return definitions;
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseDirectives(): void {
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.parseArguments();
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.advance();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.advance();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.expectName();
        this.parseDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.parseDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.parseDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.advance();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLSyntaxError('expected a value');
  }
}

// ------------------------------------------------------------------ executor

/** A source object the executor resolves fields against. */
type Source = Record<string, unknown> & { __typename?: string };

interface ExecutionContext {
  readonly forge: Forge;
  readonly variables: Record<string, unknown>;
  readonly fragments: Map<string, FragmentNode>;
  readonly errors: { message: string; path: (string | number)[] }[];
}

interface FieldDef {
  readonly type: string;
  readonly resolve: (ctx: ExecutionContext, source: Source, args: Record<string, unknown>) => unknown;
}

/** Coerce an AST value to a runtime value, resolving variables. */
function coerceValue(node: ValueNode, ctx: ExecutionContext): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = ctx.variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => coerceValue(entry, ctx));
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) object[field.name] = coerceValue(field.value, ctx);
      return object;
    }
  }
}

/** Coerce a field's argument list to a name/value record. */
function coerceArgs(field: FieldNode, ctx: ExecutionContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = coerceValue(arg.value, ctx);
  return args;
}

/** Encode a connection cursor: the index of an item in its ordered list. */
function encodeCursor(index: number): string {
  return Buffer.from(`v1:${index}`, 'utf8').toString('base64');
}

/** Decode a connection cursor, or null when it is not one. */
function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^v1:(\d+)$/.exec(decoded);
  return match === null ? null : Number.parseInt(match[1] as string, 10);
}

/** Slice an ordered list into a connection shape honoring first/after. */
function connection<T>(
  items: readonly T[],
  args: Record<string, unknown>,
  typeName: string,
): Source {
  const afterIndex = decodeCursor(args.after);
  const start = afterIndex === null ? 0 : afterIndex + 1;
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : items.length;
  const slice = items.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  return {
    __typename: typeName,
    nodes: slice,
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length === 0 ? null : encodeCursor(start),
      endCursor: slice.length === 0 ? null : encodeCursor(endIndex),
    },
  };
}

/** The issue connection for a repository, honoring states/orderBy/after. */
function issuesConnection(
  forge: Forge,
  repo: RepoRecord,
  args: Record<string, unknown>,
): Source {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  issues.sort((a, b) => {
    const bySeq = a.seq - b.seq;
    if (bySeq !== 0) return direction === 'asc' ? bySeq : -bySeq;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  const nodes = issues.map((issue) => ({ __typename: 'Issue', repo, issue }));
  return connection(nodes, args, 'IssueConnection');
}

/** The pull-request connection for a repository. */
function pullsConnection(
  forge: Forge,
  repo: RepoRecord,
  args: Record<string, unknown>,
): Source {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let pulls = [...repo.pulls.values()];
  const stateOf = (pull: PullRecord): string => (pull.merged ? 'MERGED' : pull.state.toUpperCase());
  if (states !== null) {
    const wanted = new Set(states);
    pulls = pulls.filter((pull) => wanted.has(stateOf(pull)));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => b.seq - a.seq || b.number - a.number);
  const nodes = pulls.map((pull) => ({ __typename: 'PullRequest', repo, pull }));
  return connection(nodes, args, 'PullRequestConnection');
}

/** Resolve a global id to a Node source, or null. */
function resolveNode(forge: Forge, id: unknown): Source | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const dbid = Number.parseInt(parsed.parts[0] ?? '', 10);
  if (!Number.isInteger(dbid)) return null;
  const repo = forge.getRepoByDbid(dbid);
  if (parsed.kind === 'User') {
    const user = [VIEWER, userByLogin('quinnkeller'), userByLogin('olga bauer')].find(
      (entry) => entry?.id === dbid,
    );
    return user === undefined || user === null ? null : { __typename: 'User', user };
  }
  if (repo === undefined) return null;
  if (parsed.kind === 'Repository') return { __typename: 'Repository', repo };
  const number = Number.parseInt(parsed.parts[1] ?? '', 10);
  if (!Number.isInteger(number)) return null;
  if (parsed.kind === 'Issue') {
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { __typename: 'Issue', repo, issue };
  }
  if (parsed.kind === 'PullRequest') {
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
  }
  if (parsed.kind === 'IssueComment') {
    const commentId = number;
    for (const issue of repo.issues.values()) {
      const found = issue.comments.find((comment) => comment.id === commentId);
      if (found !== undefined) return { __typename: 'IssueComment', repo, comment: found };
    }
    for (const pull of repo.pulls.values()) {
      const found = pull.comments.find((comment) => comment.id === commentId);
      if (found !== undefined) return { __typename: 'IssueComment', repo, comment: found };
    }
    return null;
  }
  return null;
}

/** The enum value sets, for __type enumValues. */
const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestChangedFileChangeType: ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'],
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime', 'GitObjectID']);

const schema: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: {
      type: 'User',
      resolve: () => ({ __typename: 'User', user: VIEWER }),
    },
    repository: {
      type: 'Repository',
      resolve: (ctx, _source, args) => {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        const repo = ctx.forge.getRepo(owner, name);
        return repo === undefined ? null : { __typename: 'Repository', repo };
      },
    },
    node: {
      type: 'Node',
      resolve: (ctx, _source, args) => resolveNode(ctx.forge, args.id),
    },
    __type: {
      type: '__Type',
      resolve: (_ctx, _source, args) => {
        const name = args.name;
        if (typeof name !== 'string') return null;
        if (schema[name] === undefined && ENUM_VALUES[name] === undefined && !SCALAR_TYPES.has(name)) {
          return null;
        }
        return { __typename: '__Type', typeName: name };
      },
    },
    __schema: {
      type: '__Schema',
      resolve: () => ({ __typename: '__Schema' }),
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const node = resolveNode(ctx.forge, input.repositoryId);
        const title = input.title;
        if (node === null || node.__typename !== 'Repository' || typeof title !== 'string' || title === '') {
          throw new Error('createIssue needs a repository id and a title');
        }
        const repo = node.repo as RepoRecord;
        const issue = ctx.forge.createIssue(repo, {
          title,
          body: typeof input.body === 'string' ? input.body : undefined,
        });
        return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const node = resolveNode(ctx.forge, input.issueId);
        if (node === null || node.__typename !== 'Issue') throw new Error('closeIssue needs an issue id');
        const repo = node.repo as RepoRecord;
        const issue = node.issue as IssueRecord;
        ctx.forge.updateIssue(repo, issue, { state: 'closed' });
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const node = resolveNode(ctx.forge, input.repositoryId);
        const title = input.title;
        const headRef = input.headRefName;
        const baseRef = input.baseRefName;
        if (node === null || node.__typename !== 'Repository') throw new Error('createPullRequest needs a repository id');
        if (typeof title !== 'string' || typeof headRef !== 'string' || typeof baseRef !== 'string') {
          throw new Error('createPullRequest needs a title, a head ref and a base ref');
        }
        const repo = node.repo as RepoRecord;
        if (ctx.forge.getRef(repo, `refs/heads/${headRef}`) === undefined) {
          throw new Error(`head branch ${headRef} does not exist`);
        }
        if (ctx.forge.getRef(repo, `refs/heads/${baseRef}`) === undefined) {
          throw new Error(`base branch ${baseRef} does not exist`);
        }
        if (ctx.forge.findOpenPull(repo, headRef, baseRef) !== undefined) {
          throw new Error('a pull request already exists for this head and base');
        }
        const pull = ctx.forge.createPull(repo, {
          title,
          body: typeof input.body === 'string' ? input.body : undefined,
          headRef,
          baseRef,
        });
        return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const node = resolveNode(ctx.forge, input.pullRequestId);
        if (node === null || node.__typename !== 'PullRequest') {
          throw new Error('mergePullRequest needs a pull request id');
        }
        const repo = node.repo as RepoRecord;
        const pull = node.pull as PullRecord;
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
        const result = ctx.forge.mergePull(repo, pull, method);
        if ('error' in result) {
          if (result.error === 'conflict') throw new Error('Pull request has merge conflicts');
          throw new Error('Pull request cannot be merged');
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (ctx, _source, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const node = resolveNode(ctx.forge, input.subjectId);
        const body = input.body;
        if (node === null || (node.__typename !== 'Issue' && node.__typename !== 'PullRequest')) {
          throw new Error('addComment needs an issue or pull request id');
        }
        if (typeof body !== 'string') throw new Error('addComment needs a body');
        const repo = node.repo as RepoRecord;
        const record = (node.issue ?? node.pull) as IssueRecord | PullRecord;
        const comment = ctx.forge.addComment(record, body);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', repo, comment },
          },
        };
      },
    },
  },
  User: {
    id: { type: 'ID', resolve: (_ctx, source) => Buffer.from(`User:${(source.user as ScenarioUser).id}`, 'utf8').toString('base64') },
    login: { type: 'String', resolve: (_ctx, source) => (source.user as ScenarioUser).login },
    name: { type: 'String', resolve: (_ctx, source) => (source.user as ScenarioUser).name },
    email: { type: 'String', resolve: (_ctx, source) => (source.user as ScenarioUser).email },
    url: { type: 'URI', resolve: (_ctx, source) => `https://example.invalid/${(source.user as ScenarioUser).login}` },
  },
  Repository: {
    id: { type: 'ID', resolve: (ctx, source) => ctx.forge.repoGlobalId(source.repo as RepoRecord) },
    databaseId: { type: 'Int', resolve: (_ctx, source) => (source.repo as RepoRecord).dbid },
    name: { type: 'String', resolve: (_ctx, source) => (source.repo as RepoRecord).name },
    nameWithOwner: {
      type: 'String',
      resolve: (_ctx, source) => {
        const repo = source.repo as RepoRecord;
        return `${repo.owner}/${repo.name}`;
      },
    },
    description: { type: 'String', resolve: (_ctx, source) => (source.repo as RepoRecord).description },
    isPrivate: { type: 'Boolean', resolve: (_ctx, source) => (source.repo as RepoRecord).isPrivate },
    url: {
      type: 'URI',
      resolve: (_ctx, source) => {
        const repo = source.repo as RepoRecord;
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      },
    },
    owner: { type: 'User', resolve: () => ({ __typename: 'User', user: VIEWER }) },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (ctx, source) => {
        const repo = source.repo as RepoRecord;
        const tip = ctx.forge.defaultTip(repo);
        if (tip === undefined) return null;
        return { __typename: 'Ref', repo, name: DEFAULT_BRANCH, oid: tip };
      },
    },
    viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    createdAt: { type: 'DateTime', resolve: (_ctx, source) => (source.repo as RepoRecord).createdAt },
    updatedAt: { type: 'DateTime', resolve: (_ctx, source) => (source.repo as RepoRecord).updatedAt },
    issue: {
      type: 'Issue',
      resolve: (ctx, source, args) => {
        const repo = source.repo as RepoRecord;
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : { __typename: 'Issue', repo, issue };
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (ctx, source, args) => issuesConnection(ctx.forge, source.repo as RepoRecord, args),
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (_ctx, source, args) => {
        const repo = source.repo as RepoRecord;
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
      },
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (ctx, source, args) => pullsConnection(ctx.forge, source.repo as RepoRecord, args),
    },
  },
  Ref: {
    name: { type: 'String', resolve: (_ctx, source) => source.name as string },
    target: {
      type: 'GitObject',
      resolve: (_ctx, source) => ({ __typename: 'Commit', oid: source.oid as string }),
    },
  },
  Commit: {
    oid: { type: 'GitObjectID', resolve: (_ctx, source) => source.oid as string },
    id: { type: 'ID', resolve: (_ctx, source) => source.oid as string },
  },
  Issue: {
    id: { type: 'ID', resolve: (ctx, source) => ctx.forge.issueGlobalId(source.repo as RepoRecord, source.issue as IssueRecord) },
    number: { type: 'Int', resolve: (_ctx, source) => (source.issue as IssueRecord).number },
    title: { type: 'String', resolve: (_ctx, source) => (source.issue as IssueRecord).title },
    body: { type: 'String', resolve: (_ctx, source) => (source.issue as IssueRecord).body },
    state: {
      type: 'IssueState',
      resolve: (_ctx, source) => (source.issue as IssueRecord).state.toUpperCase(),
    },
    createdAt: { type: 'DateTime', resolve: (_ctx, source) => (source.issue as IssueRecord).createdAt },
    updatedAt: { type: 'DateTime', resolve: (_ctx, source) => (source.issue as IssueRecord).updatedAt },
    author: { type: 'User', resolve: () => ({ __typename: 'User', user: VIEWER }) },
    repository: {
      type: 'Repository',
      resolve: (_ctx, source) => ({ __typename: 'Repository', repo: source.repo as RepoRecord }),
    },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (ctx, source) => ctx.forge.pullGlobalId(source.repo as RepoRecord, source.pull as PullRecord) },
    number: { type: 'Int', resolve: (_ctx, source) => (source.pull as PullRecord).number },
    title: { type: 'String', resolve: (_ctx, source) => (source.pull as PullRecord).title },
    body: { type: 'String', resolve: (_ctx, source) => (source.pull as PullRecord).body },
    state: {
      type: 'PullRequestState',
      resolve: (_ctx, source) => {
        const pull = source.pull as PullRecord;
        if (pull.merged) return 'MERGED';
        return pull.state.toUpperCase();
      },
    },
    merged: { type: 'Boolean', resolve: (_ctx, source) => (source.pull as PullRecord).merged },
    mergedAt: { type: 'DateTime', resolve: (_ctx, source) => (source.pull as PullRecord).mergedAt },
    headRefName: { type: 'String', resolve: (_ctx, source) => (source.pull as PullRecord).headRef },
    baseRefName: { type: 'String', resolve: (_ctx, source) => (source.pull as PullRecord).baseRef },
    mergeable: {
      type: 'MergeableState',
      resolve: (ctx, source) => ctx.forge.pullMergeable(source.repo as RepoRecord, source.pull as PullRecord),
    },
    createdAt: { type: 'DateTime', resolve: (_ctx, source) => (source.pull as PullRecord).createdAt },
    updatedAt: { type: 'DateTime', resolve: (_ctx, source) => (source.pull as PullRecord).updatedAt },
    author: { type: 'User', resolve: () => ({ __typename: 'User', user: VIEWER }) },
    repository: {
      type: 'Repository',
      resolve: (_ctx, source) => ({ __typename: 'Repository', repo: source.repo as RepoRecord }),
    },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (ctx, source, args) => {
        const repo = source.repo as RepoRecord;
        const pull = source.pull as PullRecord;
        const nodes = ctx.forge.pullRequestFiles(repo, pull).map((entry) => ({
          __typename: 'PullRequestChangedFile',
          path: entry.filename,
          additions: entry.additions,
          deletions: entry.deletions,
          changeType:
            entry.status === 'added' ? 'ADDED' : entry.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        }));
        return connection(nodes, args, 'PullRequestChangedFileConnection');
      },
    },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (_ctx, source) => source.path as string },
    additions: { type: 'Int', resolve: (_ctx, source) => source.additions as number },
    deletions: { type: 'Int', resolve: (_ctx, source) => source.deletions as number },
    changeType: { type: 'PullRequestChangedFileChangeType', resolve: (_ctx, source) => source.changeType as string },
  },
  IssueComment: {
    id: { type: 'ID', resolve: (ctx, source) => ctx.forge.commentGlobalId(source.repo as RepoRecord, source.comment as CommentRecord) },
    body: { type: 'String', resolve: (_ctx, source) => (source.comment as { body: string }).body },
    author: { type: 'User', resolve: () => ({ __typename: 'User', user: VIEWER }) },
    createdAt: { type: 'DateTime', resolve: (_ctx, source) => (source.comment as { createdAt: string }).createdAt },
    updatedAt: { type: 'DateTime', resolve: (_ctx, source) => (source.comment as { updatedAt: string }).updatedAt },
  },
  IssueConnection: {
    nodes: { type: '[Issue]', resolve: (_ctx, source) => source.nodes as unknown[] },
    totalCount: { type: 'Int', resolve: (_ctx, source) => source.totalCount as number },
    pageInfo: { type: 'PageInfo', resolve: (_ctx, source) => source.pageInfo as Source },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]', resolve: (_ctx, source) => source.nodes as unknown[] },
    totalCount: { type: 'Int', resolve: (_ctx, source) => source.totalCount as number },
    pageInfo: { type: 'PageInfo', resolve: (_ctx, source) => source.pageInfo as Source },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]', resolve: (_ctx, source) => source.nodes as unknown[] },
    totalCount: { type: 'Int', resolve: (_ctx, source) => source.totalCount as number },
    pageInfo: { type: 'PageInfo', resolve: (_ctx, source) => source.pageInfo as Source },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (_ctx, source) => source.hasNextPage as boolean },
    hasPreviousPage: { type: 'Boolean', resolve: (_ctx, source) => source.hasPreviousPage as boolean },
    startCursor: { type: 'String', resolve: (_ctx, source) => (source.startCursor as string | null) ?? null },
    endCursor: { type: 'String', resolve: (_ctx, source) => (source.endCursor as string | null) ?? null },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, source) => source.issue as Source },
    clientMutationId: { type: 'String', resolve: () => null },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, source) => source.issue as Source },
    clientMutationId: { type: 'String', resolve: () => null },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, source) => source.pullRequest as Source },
    clientMutationId: { type: 'String', resolve: () => null },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, source) => source.pullRequest as Source },
    clientMutationId: { type: 'String', resolve: () => null },
  },
  AddCommentPayload: {
    commentEdge: { type: 'IssueCommentEdge', resolve: (_ctx, source) => source.commentEdge as Source },
    clientMutationId: { type: 'String', resolve: () => null },
  },
  IssueCommentEdge: {
    node: { type: 'IssueComment', resolve: (_ctx, source) => source.node as Source },
    cursor: { type: 'String', resolve: () => '' },
  },
  __Type: {
    name: { type: 'String', resolve: (_ctx, source) => source.typeName as string },
    kind: {
      type: 'String',
      resolve: (_ctx, source) => {
        const name = source.typeName as string;
        if (ENUM_VALUES[name] !== undefined) return 'ENUM';
        if (SCALAR_TYPES.has(name)) return 'SCALAR';
        return 'OBJECT';
      },
    },
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '[__Field]',
      resolve: (_ctx, source) => {
        const name = source.typeName as string;
        const fields = schema[name];
        if (fields === undefined) return [];
        return Object.keys(fields)
          .filter((field) => !field.startsWith('__'))
          .map((field) => ({ __typename: '__Field', name: field }));
      },
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (_ctx, source) => {
        const name = source.typeName as string;
        const values = ENUM_VALUES[name];
        if (values === undefined) return [];
        return values.map((value) => ({ __typename: '__EnumValue', name: value }));
      },
    },
  },
  __Field: {
    name: { type: 'String', resolve: (_ctx, source) => source.name as string },
    description: { type: 'String', resolve: () => null },
  },
  __EnumValue: {
    name: { type: 'String', resolve: (_ctx, source) => source.name as string },
    description: { type: 'String', resolve: () => null },
  },
  __Schema: {
    queryType: { type: '__Type', resolve: () => ({ __typename: '__Type', typeName: 'Query' }) },
    mutationType: { type: '__Type', resolve: () => ({ __typename: '__Type', typeName: 'Mutation' }) },
    description: { type: 'String', resolve: () => null },
  },
};

/** The effective type name of a resolved value: its own, or the field's. */
function effectiveType(value: Source, fieldType: string): string {
  if (typeof value.__typename === 'string') return value.__typename;
  return fieldType.replace(/[\[\]!]/g, '');
}

/** Execute a selection set against one object value. */
function executeSelectionSet(
  ctx: ExecutionContext,
  typeName: string,
  source: Source,
  selections: readonly SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== typeName && fragment.typeCondition !== 'Node') continue;
      Object.assign(result, executeSelectionSet(ctx, typeName, source, fragment.selections, path));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName && selection.typeCondition !== 'Node') {
        continue;
      }
      Object.assign(result, executeSelectionSet(ctx, typeName, source, selection.selections, path));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      result[responseKey] = typeName;
      continue;
    }
    const fields = schema[typeName];
    const def = fields?.[selection.name];
    if (def === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${selection.name}" on type "${typeName}".`,
        path: fieldPath,
      });
      result[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = def.resolve(ctx, source, coerceArgs(selection, ctx));
    } catch (err) {
      ctx.errors.push({ message: (err as Error).message, path: fieldPath });
      result[responseKey] = null;
      continue;
    }
    result[responseKey] = executeValue(ctx, def.type, value, selection.selections, fieldPath);
  }
  return result;
}

/** Execute a resolved value against a field's return type and subselections. */
function executeValue(
  ctx: ExecutionContext,
  type: string,
  value: unknown,
  selections: readonly SelectionNode[] | null,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return null;
  const unwrapped = type.replace(/!/g, '');
  if (unwrapped.startsWith('[') && unwrapped.endsWith(']')) {
    if (!Array.isArray(value)) return null;
    const itemType = unwrapped.slice(1, -1);
    return value.map((entry, index) => executeValue(ctx, itemType, entry, selections, [...path, index]));
  }
  const named = unwrapped;
  if (SCALAR_TYPES.has(named) || ENUM_VALUES[named] !== undefined) return value;
  if (typeof value !== 'object') return null;
  const source = value as Source;
  const concrete = effectiveType(source, named);
  if (selections === null) return {};
  return executeSelectionSet(ctx, concrete, source, selections, path);
}

/** Execute one GraphQL request object. */
export function executeGraphQL(
  forge: Forge,
  request: { query?: unknown; variables?: unknown; operationName?: unknown },
): { data: Record<string, unknown> | null; errors?: { message: string; path: (string | number)[] }[] } {
  if (typeof request.query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string', path: [] }] };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(request.query).parseDocument();
  } catch (err) {
    if (err instanceof GraphQLSyntaxError) {
      return { data: null, errors: [{ message: err.message, path: [] }] };
    }
    throw err;
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationNode | undefined;
  if (typeof request.operationName === 'string') {
    operation = operations.find((entry) => entry.name === request.operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `unknown operation ${JSON.stringify(request.operationName)}`, path: [] }] };
    }
  } else {
    if (operations.length !== 1) {
      return { data: null, errors: [{ message: 'operationName is required when several operations are present', path: [] }] };
    }
    operation = operations[0] as OperationNode;
  }
  let variables: Record<string, unknown> = {};
  if (request.variables !== undefined && request.variables !== null) {
    if (typeof request.variables === 'string') {
      try {
        const parsed: unknown = JSON.parse(request.variables);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          variables = parsed as Record<string, unknown>;
        }
      } catch {
        variables = {};
      }
    } else if (typeof request.variables === 'object' && !Array.isArray(request.variables)) {
      variables = request.variables as Record<string, unknown>;
    }
  }
  // Variable defaults from the operation's definitions fill gaps.
  for (const definition of operation.variableDefinitions) {
    if (variables[definition.name] === undefined && definition.defaultValue !== null) {
      variables[definition.name] = coerceValue(definition.defaultValue, {
        forge,
        variables,
        fragments,
        errors: [],
      });
    }
  }
  const ctx: ExecutionContext = { forge, variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, { __typename: rootType }, operation.selections, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle one POST /api/graphql body: a single request or a batch array. */
export function handleGraphQL(
  forge: Forge,
  rawBody: Buffer,
): { status: number; json: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.length === 0 ? '{}' : rawBody.toString('utf8'));
  } catch {
    return { status: 400, json: { errors: [{ message: 'request body is not valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, json: parsed.map((entry) => executeGraphQL(forge, entry ?? {})) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, json: { errors: [{ message: 'request body must be a JSON object or array' }] } };
  }
  const result = executeGraphQL(forge, parsed as { query?: unknown; variables?: unknown; operationName?: unknown });
  if (result.data === null && result.errors !== undefined && result.errors.length > 0) {
    const message = result.errors[0]?.message ?? '';
    // Request-level failures (no query, bad syntax) are 400s; field-level
    // failures already carry partial data and stay 200.
    if (message === 'query must be a string' || message.startsWith('unknown operation') || message.startsWith('operationName')) {
      return { status: 400, json: result };
    }
  }
  return { status: 200, json: result };
}
