// The MCP surface: Streamable HTTP carrying JSON-RPC 2.0, answered with
// single JSON bodies (no SSE). It speaks both the modern discovery era
// (server/discover) and the legacy initialize handshake, and exposes six
// tools over the same store the REST surface uses, so a tool call and a
// REST call always agree.

import { Forge, type RepoRecord } from './store.ts';
import { issueObject, pullObject, repoObject } from './rest.ts';
import { VIEWER } from './scenario.ts';

/** The protocol versions this server claims, newest first. */
const SUPPORTED_VERSIONS = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** The server identity both handshakes report. */
const SERVER_INFO = Object.freeze({ name: 'github-forge', version: '1.0.0' });

/** One tool's static definition: name, description and input schema. */
interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
  };
}

/**
 * The tool list. It is frozen and shared, so every tools/list answer is
 * byte-identical. Required arrays hold only properties the suite fills.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'An optional description.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        full_name: Object.freeze({ type: 'string', description: 'owner/repo, an alternative to owner and repo.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
        labels: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }), description: 'Label names; they must already exist.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', enum: Object.freeze(['open', 'closed', 'all']), description: 'Filter by state.' }),
        full_name: Object.freeze({ type: 'string', description: 'owner/repo, an alternative to owner and repo.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request between two branches of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
        merge_method: Object.freeze({ type: 'string', enum: Object.freeze(['merge', 'squash', 'rebase']), description: 'The merge method.' }),
        full_name: Object.freeze({ type: 'string', description: 'owner/repo, an alternative to owner and repo.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

/** A tool-call failure that is the caller's fault: bad or missing arguments. */
class InvalidParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParams';
  }
}

/** A tool-call failure in the domain: reported as an isError result, not a protocol error. */
class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolFailure';
  }
}

/** A string argument, or an InvalidParams error when it is absent or not a string. */
function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new InvalidParams(`argument ${key} must be a non-empty string`);
  return value;
}

/** An optional string argument. */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/** Resolve owner/repo from arguments, accepting full_name as a fallback. */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  const owner = optionalString(args, 'owner');
  const repo = optionalString(args, 'repo');
  if (owner !== undefined && repo !== undefined) return { owner, repo };
  const fullName = optionalString(args, 'full_name');
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0 && slash < fullName.length - 1) {
      return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
    }
  }
  throw new InvalidParams('arguments must include owner and repo (or full_name)');
}

/** The repository named by the arguments, or a ToolFailure when it is absent. */
function requireRepo(forge: Forge, args: Record<string, unknown>): RepoRecord {
  const { owner, repo: name } = resolveRepoArgs(args);
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw new ToolFailure(`repository ${owner}/${name} does not exist`);
  return repo;
}

/** A branch name from a head/base argument, dropping an `owner:` prefix. */
function branchName(value: string): string {
  const colon = value.indexOf(':');
  return colon < 0 ? value : value.slice(colon + 1);
}

/** Wrap a tool result the way the suite reads it: JSON text plus structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** Wrap a domain failure as an isError tool result. */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Run one tool by name. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = requiredString(args, 'name');
      const repo = forge.createRepo(VIEWER.login, repoName, {
        description: optionalString(args, 'description'),
        isPrivate: typeof args.private === 'boolean' ? args.private : undefined,
      });
      if (repo === null) throw new ToolFailure(`repository ${repoName} already exists`);
      return toolResult(repoObject(forge, repo));
    }
    case 'get_repo': {
      const repo = requireRepo(forge, args);
      return toolResult(repoObject(forge, repo));
    }
    case 'create_issue': {
      const repo = requireRepo(forge, args);
      const title = requiredString(args, 'title');
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]) : [];
      for (const label of labels) {
        if (typeof label !== 'string' || !repo.labels.has(label)) {
          throw new ToolFailure(`label ${JSON.stringify(label)} does not exist`);
        }
      }
      const issue = forge.createIssue(repo, {
        title,
        body: optionalString(args, 'body'),
        labels: labels as string[],
      });
      return toolResult(issueObject(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = requireRepo(forge, args);
      const state = optionalString(args, 'state') ?? 'open';
      const issues = forge.listIssues(repo, { state });
      const value = issues.map((issue) => issueObject(forge, repo, issue));
      return toolResult(value);
    }
    case 'create_pull_request': {
      const repo = requireRepo(forge, args);
      const title = requiredString(args, 'title');
      const headRef = branchName(requiredString(args, 'head'));
      const baseRef = branchName(requiredString(args, 'base'));
      if (forge.getRef(repo, `refs/heads/${headRef}`) === undefined) {
        throw new ToolFailure(`head branch ${headRef} does not exist`);
      }
      if (forge.getRef(repo, `refs/heads/${baseRef}`) === undefined) {
        throw new ToolFailure(`base branch ${baseRef} does not exist`);
      }
      if (forge.findOpenPull(repo, headRef, baseRef) !== undefined) {
        throw new ToolFailure('a pull request already exists for this head and base');
      }
      const pull = forge.createPull(repo, {
        title,
        body: optionalString(args, 'body'),
        headRef,
        baseRef,
      });
      return toolResult(pullObject(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(forge, args);
      const pullNumber = args.pull_number;
      if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber) || pullNumber < 1) {
        throw new InvalidParams('pull_number must be a positive integer');
      }
      const pull = forge.getPull(repo, pullNumber);
      if (pull === undefined) throw new ToolFailure(`pull request #${pullNumber} does not exist`);
      const method = optionalString(args, 'merge_method') ?? 'squash';
      const result = forge.mergePull(repo, pull, method);
      if ('error' in result) {
        if (result.error === 'conflict') throw new ToolFailure('pull request has merge conflicts');
        throw new ToolFailure('pull request cannot be merged');
      }
      return toolResult({ ...pullObject(forge, repo, pull), sha: result.sha });
    }
    default:
      throw new InvalidParams(`unknown tool ${JSON.stringify(name)}`);
  }
}

/** A JSON-RPC success envelope. */
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** A JSON-RPC error envelope. */
function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Handle one POST /mcp body. Returns the HTTP status and the JSON value to
 * send, or null for a 202 notification acknowledgement with an empty body.
 */
export function handleMcp(forge: Forge, rawBody: Buffer): { status: number; json: unknown | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.length === 0 ? 'null' : rawBody.toString('utf8'));
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'request body is not valid JSON') };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, json: rpcError(null, -32600, 'request must be a JSON-RPC object') };
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id;
  const hasId = id !== undefined;
  const method = request.method;
  // Notifications (no id) are acknowledged with an empty 202.
  if (!hasId) return { status: 202, json: null };
  if (typeof method !== 'string') {
    return { status: 200, json: rpcError(id, -32600, 'request method must be a string') };
  }
  if (method.startsWith('notifications/')) return { status: 202, json: null };
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      status: 200,
      json: rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      }),
    };
  }
  if (method === 'initialize') {
    const requested = params.protocolVersion;
    const negotiated =
      typeof requested === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(requested)
        ? requested
        : '2025-11-25';
    return {
      status: 200,
      json: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      }),
    };
  }
  if (method === 'ping') {
    return { status: 200, json: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string') {
      return { status: 200, json: rpcError(id, -32602, 'tools/call needs a tool name') };
    }
    const args =
      params.arguments !== undefined && params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    try {
      return { status: 200, json: rpcResult(id, callTool(forge, toolName, args)) };
    } catch (err) {
      if (err instanceof InvalidParams) {
        return { status: 200, json: rpcError(id, -32602, err.message) };
      }
      if (err instanceof ToolFailure) {
        return { status: 200, json: rpcResult(id, toolError(err.message)) };
      }
      throw err;
    }
  }
  return { status: 200, json: rpcError(id, -32601, `method ${JSON.stringify(method)} is not supported`) };
}
