// The REST v3 surface: repositories, branches, refs, commits, contents,
// labels, issues and pull requests. Every reply is JSON; errors carry a
// string `message`. Pagination follows GitHub's Link-header shape with
// absolute same-origin URLs built from the request's Host header.

import { parseCommit } from './gitobjects.ts';
import {
  Forge,
  DEFAULT_BRANCH,
  type CommentRecord,
  type IssueRecord,
  type LabelRecord,
  type PullRecord,
  type RepoRecord,
} from './store.ts';
import { base64ToBytes, bytesToBase64, isHex40 } from './util.ts';
import { VIEWER, userByLogin, type ScenarioUser } from './scenario.ts';

/** What the router hands the REST layer for one request. */
export interface RestRequest {
  readonly method: string;
  /** The path after /api/v3, split into decoded segments. */
  readonly segments: string[];
  /** The full request pathname, for Link headers. */
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly host: string;
  readonly rawBody: Buffer;
}

/** What the REST layer hands back: a status, extra headers, and a JSON value. */
export interface RestResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly json: unknown;
  /**
   * A pre-serialized JSON body, when set: the app sends these bytes as-is
   * instead of stringifying `json` (which stays null there). Only for
   * replies whose bytes are fully determined by a cache key.
   */
  readonly body?: Buffer;
}

/** An error the REST layer raises: an HTTP status and a message string. */
class RestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RestError';
    this.status = status;
  }
}

const badRequest = (message: string): RestError => new RestError(400, message);
const notFound = (message = 'Not Found'): RestError => new RestError(404, message);
const unprocessable = (message: string): RestError => new RestError(422, message);
const conflict = (message: string): RestError => new RestError(409, message);
const methodNotAllowed = (message: string): RestError => new RestError(405, message);

// ------------------------------------------------------------------ shapes

/** A GitHub-shaped user object for one of the scenario users. */
export function userObject(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: Buffer.from(`User:${user.id}`, 'utf8').toString('base64'),
    avatar_url: `https://avatars.example.invalid/u/${user.id}`,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://example.invalid/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

/** A GitHub-shaped repository object. */
export function repoObject(forge: Forge, repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.dbid,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(VIEWER),
    private: repo.isPrivate,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: DEFAULT_BRANCH,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

/** A GitHub-shaped label object. */
function labelObject(repo: RepoRecord, label: LabelRecord): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${repo.dbid}:${label.id}`, 'utf8').toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: '',
  };
}

/** The viewer's user object never changes: build it once, share it everywhere. */
const VIEWER_USER_OBJECT = userObject(VIEWER);

/** Serialized GET-issue bodies, keyed by repo + issue + its mutation stamp. */
const issueJsonCache = new Map<string, Buffer>();
const ISSUE_JSON_CACHE_MAX = 1024;

/**
 * A GET-issue reply's exact bytes. The key carries the issue's updatedAt
 * (every update or comment ticks the clock) and its comment count, so any
 * mutation misses the cache and re-serializes; labels are immutable once
 * created, so nothing else in the reply can change under a live key.
 */
function cachedIssueJson(forge: Forge, repo: RepoRecord, issue: IssueRecord): Buffer {
  const key = `${repo.dbid}:${issue.number}:${issue.updatedAt}:${issue.comments.length}`;
  const hit = issueJsonCache.get(key);
  if (hit !== undefined) return hit;
  const body = Buffer.from(JSON.stringify(issueObject(forge, repo, issue)), 'utf8');
  if (issueJsonCache.size >= ISSUE_JSON_CACHE_MAX) issueJsonCache.clear();
  issueJsonCache.set(key, body);
  return body;
}

/** A GitHub-shaped issue object. */
export function issueObject(
  forge: Forge,
  repo: RepoRecord,
  issue: IssueRecord,
): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: forge.issueGlobalId(repo, issue),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: VIEWER_USER_OBJECT,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined
        ? { name, color: 'ededed' }
        : labelObject(repo, label);
    }),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

/** A GitHub-shaped pull request object; head/base shas are read live from the refs. */
export function pullObject(
  forge: Forge,
  repo: RepoRecord,
  pull: PullRecord,
): Record<string, unknown> {
  const tips = forge.pullTips(repo, pull);
  const side = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userObject(VIEWER),
    repo: repoObject(forge, repo),
  });
  return {
    id: pull.id,
    node_id: forge.pullGlobalId(repo, pull),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userObject(VIEWER),
    labels: [],
    head: side(pull.headRef, tips.headSha),
    base: side(pull.baseRef, tips.baseSha),
    merged: pull.merged,
    mergeable: null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
  };
}

/** A GitHub-shaped issue-comment object. */
function commentObject(
  forge: Forge,
  repo: RepoRecord,
  record: IssueRecord | PullRecord,
  comment: CommentRecord,
): Record<string, unknown> {
  void record;
  return {
    id: comment.id,
    node_id: forge.commentGlobalId(repo, comment),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    body: comment.body,
    user: userObject(VIEWER),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

/** A GitHub-shaped commit object for one commit id. */
function commitObject(forge: Forge, repo: RepoRecord, oid: string): Record<string, unknown> | null {
  const peeled = forge.peel(repo, oid);
  if (peeled === null) return null;
  const object = forge.getObject(repo, peeled);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  const person = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: '' };
    const timestamp = Number(match[3]);
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: new Date(timestamp * 1000).toISOString(),
    };
  };
  const author = person(view.author);
  const committer = person(view.committer);
  return {
    sha: peeled,
    node_id: Buffer.from(`Commit:${repo.dbid}:${peeled}`, 'utf8').toString('base64'),
    commit: {
      message: view.message,
      author,
      committer,
      tree: { sha: view.tree },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${peeled}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${peeled}`,
    author: userObject(VIEWER),
    committer: userObject(VIEWER),
    parents: view.parents.map((sha) => ({ sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` })),
  };
}

// -------------------------------------------------------------- pagination

interface Page<T> {
  readonly items: T[];
  readonly page: number;
  readonly perPage: number;
  readonly totalPages: number;
}

/** Slice a list per page/per_page, clamping both into sane ranges. */
function paginate<T>(all: readonly T[], query: URLSearchParams): Page<T> {
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const perPage = Number.isInteger(rawPerPage) && rawPerPage > 0 ? Math.min(rawPerPage, 100) : 30;
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  return { items: all.slice(start, start + perPage), page, perPage, totalPages };
}

/** A Link header for a page, with absolute same-origin URLs. */
function linkHeader(
  request: RestRequest,
  page: Page<unknown>,
  extraParams: Record<string, string> = {},
): string {
  const build = (pageNumber: number): string => {
    const params = new URLSearchParams(request.query);
    params.set('page', String(pageNumber));
    params.set('per_page', String(page.perPage));
    for (const [key, value] of Object.entries(extraParams)) params.set(key, value);
    return `http://${request.host}${request.pathname}?${params.toString()}`;
  };
  const links: string[] = [`<${build(1)}>; rel="first"`, `<${build(page.totalPages)}>; rel="last"`];
  if (page.page > 1) links.push(`<${build(page.page - 1)}>; rel="prev"`);
  if (page.page < page.totalPages) links.push(`<${build(page.page + 1)}>; rel="next"`);
  return links.join(', ');
}

// ------------------------------------------------------------------ helpers

/** Parse a JSON request body: an empty body reads as an empty object; bad JSON is a 400. */
function parseBody(request: RestRequest): Record<string, unknown> {
  if (request.rawBody.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.rawBody.toString('utf8'));
  } catch {
    throw badRequest('request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** A string field of a body, or undefined when absent or not a string. */
function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** A string-array field of a body, or undefined when absent or not an array of strings. */
function stringArrayField(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === 'string')) return undefined;
  return value as string[];
}

/** Resolve owner/repo from the path: only the viewer's repositories exist. */
function requireRepo(forge: Forge, owner: string, name: string): RepoRecord {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw notFound('Not Found');
  return repo;
}

/** A branch name from a head/base value, dropping an `owner:` prefix. */
function branchName(value: string): string {
  const colon = value.indexOf(':');
  return colon < 0 ? value : value.slice(colon + 1);
}

/** Validate that every label name exists in the repository. */
function requireLabels(repo: RepoRecord, names: readonly string[]): void {
  for (const name of names) {
    if (!repo.labels.has(name)) throw unprocessable(`label ${JSON.stringify(name)} does not exist`);
  }
}

// ------------------------------------------------------------------- routes

function handleRoot(request: RestRequest): RestResponse {
  void request;
  return {
    status: 200,
    headers: { 'X-OAuth-Scopes': 'repo, read:org' },
    json: {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/api/v3/user/authorizations',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    },
  };
}

function handleMeta(): RestResponse {
  return {
    status: 200,
    headers: {},
    json: {
      verifiable_password_authentication: false,
      installed_version: '1.0.0',
      ssh_key_fingerprints: {},
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    },
  };
}

function handleListUserRepos(forge: Forge, request: RestRequest): RestResponse {
  const page = paginate(forge.listRepos(), request.query);
  return {
    status: 200,
    headers: { Link: linkHeader(request, page) },
    json: page.items.map((repo) => repoObject(forge, repo)),
  };
}

function handleCreateRepo(forge: Forge, request: RestRequest): RestResponse {
  const body = parseBody(request);
  const name = stringField(body, 'name');
  if (name === undefined || name === '') throw unprocessable('name is required');
  if (name.includes('/') || name.endsWith('.git')) throw unprocessable('name is not a valid repository name');
  const repo = forge.createRepo(VIEWER.login, name, {
    description: stringField(body, 'description'),
    isPrivate: typeof body.private === 'boolean' ? body.private : undefined,
  });
  if (repo === null) throw unprocessable(`name already exists on this account: ${name}`);
  return { status: 201, headers: {}, json: repoObject(forge, repo) };
}

function handleGetRepo(forge: Forge, owner: string, name: string): RestResponse {
  return { status: 200, headers: {}, json: repoObject(forge, requireRepo(forge, owner, name)) };
}

function handlePatchRepo(forge: Forge, request: RestRequest, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const body = parseBody(request);
  const description = stringField(body, 'description');
  if (description !== undefined) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  repo.updatedAt = forge.clock.nextIso();
  return { status: 200, headers: {}, json: repoObject(forge, repo) };
}

function handleDeleteRepo(forge: Forge, owner: string, name: string): RestResponse {
  if (!forge.deleteRepo(owner, name)) throw notFound('Not Found');
  return { status: 204, headers: {}, json: null };
}

function handleListBranches(forge: Forge, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const branches = forge
    .listRefs(repo)
    .filter((ref) => ref.name.startsWith('refs/heads/'))
    .map((ref) => {
      const branch = ref.name.slice('refs/heads/'.length);
      return {
        name: branch,
        commit: { sha: ref.oid, url: `/api/v3/repos/${owner}/${name}/commits/${ref.oid}` },
        protected: false,
      };
    });
  return { status: 200, headers: {}, json: branches };
}

function handleGetBranch(forge: Forge, owner: string, name: string, branch: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const oid = forge.getRef(repo, `refs/heads/${branch}`);
  if (oid === undefined) throw notFound('Branch not found');
  return {
    status: 200,
    headers: {},
    json: {
      name: branch,
      commit: { sha: oid, url: `/api/v3/repos/${owner}/${name}/commits/${oid}` },
      protected: false,
    },
  };
}

function handleCreateRef(forge: Forge, request: RestRequest, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const body = parseBody(request);
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (ref === undefined || !ref.startsWith('refs/')) throw unprocessable('ref must start with refs/');
  if (sha === undefined || !isHex40(sha)) throw unprocessable('sha must be a 40-hex object id');
  if (forge.getObject(repo, sha) === undefined) throw unprocessable(`object ${sha} does not exist`);
  if (forge.getRef(repo, ref) !== undefined) throw unprocessable(`ref ${ref} already exists`);
  forge.setRef(repo, ref, sha);
  const object = forge.getObject(repo, sha) as { type: string };
  return {
    status: 201,
    headers: {},
    json: {
      ref,
      node_id: Buffer.from(`Ref:${repo.dbid}:${ref}`, 'utf8').toString('base64'),
      url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice('refs/'.length)}`,
      object: { sha, type: object.type, url: `/api/v3/repos/${owner}/${name}/git/${object.type}s/${sha}` },
    },
  };
}

function handleGetRef(forge: Forge, owner: string, name: string, refPath: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const refName = `refs/${refPath}`;
  const exact = forge.getRef(repo, refName);
  const shape = (ref: string, sha: string): Record<string, unknown> => {
    const object = forge.getObject(repo, sha);
    return {
      ref,
      node_id: Buffer.from(`Ref:${repo.dbid}:${ref}`, 'utf8').toString('base64'),
      url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice('refs/'.length)}`,
      object: {
        sha,
        type: object?.type ?? 'commit',
        url: `/api/v3/repos/${owner}/${name}/git/${object?.type ?? 'commit'}s/${sha}`,
      },
    };
  };
  if (exact !== undefined) return { status: 200, headers: {}, json: shape(refName, exact) };
  const matches = forge.listRefs(repo).filter((ref) => ref.name.startsWith(`${refName}/`));
  if (matches.length > 0) {
    return { status: 200, headers: {}, json: matches.map((ref) => shape(ref.name, ref.oid)) };
  }
  throw notFound('Reference not found');
}

function handleListCommits(forge: Forge, request: RestRequest, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const shaParam = request.query.get('sha');
  let tip: string | undefined;
  if (shaParam !== null) {
    tip = forge.resolveRef(repo, shaParam);
    if (tip === undefined) throw notFound('No commit found for SHA');
  } else {
    tip = forge.defaultTip(repo);
  }
  if (tip === undefined) return { status: 200, headers: {}, json: [] };
  const oids = forge.walkCommits(repo, tip);
  const page = paginate(oids, request.query);
  const commits = page.items
    .map((oid) => commitObject(forge, repo, oid))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  return {
    status: 200,
    headers: { Link: linkHeader(request, page) },
    json: commits,
  };
}

function handleGetCommit(forge: Forge, owner: string, name: string, sha: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const resolved = forge.resolveRef(repo, sha);
  if (resolved === undefined) throw notFound('No commit found for SHA');
  const object = commitObject(forge, repo, resolved);
  if (object === null) throw notFound('No commit found for SHA');
  return { status: 200, headers: {}, json: object };
}

function handleGetContents(forge: Forge, request: RestRequest, owner: string, name: string, path: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const refParam = request.query.get('ref');
  const tip = refParam !== null ? forge.resolveRef(repo, refParam) : forge.defaultTip(repo);
  if (tip === undefined) throw notFound('Not Found');
  const read = forge.readPath(repo, tip, path);
  if (read === null) throw notFound('Not Found');
  if (read.kind === 'file') {
    const segments = path.split('/');
    return {
      status: 200,
      headers: {},
      json: {
        type: 'file',
        encoding: 'base64',
        size: read.size,
        name: segments[segments.length - 1],
        path,
        content: bytesToBase64(read.data),
        sha: read.oid,
        url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
        html_url: `https://example.invalid/${owner}/${name}/blob/${refParam ?? DEFAULT_BRANCH}/${path}`,
      },
    };
  }
  return {
    status: 200,
    headers: {},
    json: read.entries.map((entry) => {
      const isDir = entry.mode === '40000';
      const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
      const blob = isDir ? undefined : forge.getObject(repo, entry.oid);
      return {
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : (blob?.data.length ?? 0),
        name: entry.name,
        path: entryPath,
        sha: entry.oid,
        url: `/api/v3/repos/${owner}/${name}/contents/${entryPath}`,
        html_url: `https://example.invalid/${owner}/${name}/${isDir ? 'tree' : 'blob'}/${refParam ?? DEFAULT_BRANCH}/${entryPath}`,
      };
    }),
  };
}

function handlePutContents(forge: Forge, request: RestRequest, owner: string, name: string, path: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const body = parseBody(request);
  const message = stringField(body, 'message');
  const content = stringField(body, 'content');
  if (message === undefined) throw unprocessable('message is required');
  if (content === undefined) throw unprocessable('content is required');
  const result = forge.putContent(repo, {
    path,
    content: base64ToBytes(content),
    message,
    branch: stringField(body, 'branch'),
    sha: stringField(body, 'sha'),
  });
  if ('error' in result) throw conflict('file has changed since the given sha');
  const segments = path.split('/');
  return {
    status: result.created ? 201 : 200,
    headers: {},
    json: {
      content: {
        name: segments[segments.length - 1],
        path,
        sha: result.blobSha,
        size: base64ToBytes(content).length,
        encoding: 'base64',
        content,
        url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
      },
      commit: {
        sha: result.commitSha,
        message,
        url: `/api/v3/repos/${owner}/${name}/commits/${result.commitSha}`,
      },
    },
  };
}

function handleDeleteContents(forge: Forge, request: RestRequest, owner: string, name: string, path: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const body = parseBody(request);
  const message = stringField(body, 'message') ?? '';
  const result = forge.deleteContent(repo, {
    path,
    message,
    branch: stringField(body, 'branch'),
    sha: stringField(body, 'sha'),
  });
  if ('error' in result) {
    if (result.error === 'not-found') throw notFound('Not Found');
    throw conflict('file has changed since the given sha');
  }
  return {
    status: 200,
    headers: {},
    json: {
      commit: {
        sha: result.commitSha,
        message,
        url: `/api/v3/repos/${owner}/${name}/commits/${result.commitSha}`,
      },
    },
  };
}

function handleListLabels(forge: Forge, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  return { status: 200, headers: {}, json: forge.listLabels(repo).map((label) => labelObject(repo, label)) };
}

function handleCreateLabel(forge: Forge, request: RestRequest, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const body = parseBody(request);
  const labelName = stringField(body, 'name');
  if (labelName === undefined || labelName === '') throw unprocessable('name is required');
  const label = forge.createLabel(repo, labelName, stringField(body, 'color'));
  return { status: 201, headers: {}, json: labelObject(repo, label) };
}

function handleListIssues(forge: Forge, request: RestRequest, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const issues = forge.listIssues(repo, {
    state: request.query.get('state') ?? undefined,
    sort: request.query.get('sort') ?? undefined,
    direction: request.query.get('direction') ?? undefined,
  });
  const page = paginate(issues, request.query);
  return {
    status: 200,
    headers: { Link: linkHeader(request, page) },
    json: page.items.map((issue) => issueObject(forge, repo, issue)),
  };
}

function handleCreateIssue(forge: Forge, request: RestRequest, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const body = parseBody(request);
  const title = stringField(body, 'title');
  if (title === undefined || title === '') throw unprocessable('title is required');
  const labels = stringArrayField(body, 'labels') ?? [];
  requireLabels(repo, labels);
  const issue = forge.createIssue(repo, { title, body: stringField(body, 'body'), labels });
  return { status: 201, headers: {}, json: issueObject(forge, repo, issue) };
}

function handleGetIssue(forge: Forge, owner: string, name: string, number: number): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const issue = forge.getIssue(repo, number);
  if (issue === undefined) throw notFound('Not Found');
  return { status: 200, headers: {}, json: null, body: cachedIssueJson(forge, repo, issue) };
}

function handlePatchIssue(forge: Forge, request: RestRequest, owner: string, name: string, number: number): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const issue = forge.getIssue(repo, number);
  if (issue === undefined) throw notFound('Not Found');
  const body = parseBody(request);
  const labels = stringArrayField(body, 'labels');
  if (labels !== undefined) requireLabels(repo, labels);
  const state = stringField(body, 'state');
  if (state !== undefined && state !== 'open' && state !== 'closed') {
    throw unprocessable('state must be open or closed');
  }
  forge.updateIssue(repo, issue, {
    title: stringField(body, 'title'),
    body: stringField(body, 'body'),
    state: state as 'open' | 'closed' | undefined,
    labels,
  });
  return { status: 200, headers: {}, json: issueObject(forge, repo, issue) };
}

function handleListComments(forge: Forge, owner: string, name: string, number: number): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const issue = forge.getIssue(repo, number);
  if (issue === undefined) throw notFound('Not Found');
  return {
    status: 200,
    headers: {},
    json: issue.comments.map((comment) => commentObject(forge, repo, issue, comment)),
  };
}

function handleCreateComment(forge: Forge, request: RestRequest, owner: string, name: string, number: number): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const issue = forge.getIssue(repo, number);
  if (issue === undefined) throw notFound('Not Found');
  const body = parseBody(request);
  const text = stringField(body, 'body');
  if (text === undefined) throw unprocessable('body is required');
  const comment = forge.addComment(issue, text);
  return { status: 201, headers: {}, json: commentObject(forge, repo, issue, comment) };
}

function handleListPulls(forge: Forge, request: RestRequest, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const pulls = forge.listPulls(repo, request.query.get('state') ?? 'open');
  const page = paginate(pulls, request.query);
  return {
    status: 200,
    headers: { Link: linkHeader(request, page) },
    json: page.items.map((pull) => pullObject(forge, repo, pull)),
  };
}

function handleCreatePull(forge: Forge, request: RestRequest, owner: string, name: string): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const body = parseBody(request);
  const title = stringField(body, 'title');
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (title === undefined || title === '') throw unprocessable('title is required');
  if (head === undefined || head === '') throw unprocessable('head is required');
  if (base === undefined || base === '') throw unprocessable('base is required');
  const headRef = branchName(head);
  const baseRef = branchName(base);
  if (forge.getRef(repo, `refs/heads/${headRef}`) === undefined) {
    throw unprocessable(`head branch ${headRef} does not exist`);
  }
  if (forge.getRef(repo, `refs/heads/${baseRef}`) === undefined) {
    throw unprocessable(`base branch ${baseRef} does not exist`);
  }
  if (forge.findOpenPull(repo, headRef, baseRef) !== undefined) {
    throw unprocessable('a pull request already exists for this head and base');
  }
  const pull = forge.createPull(repo, { title, body: stringField(body, 'body'), headRef, baseRef });
  return { status: 201, headers: {}, json: pullObject(forge, repo, pull) };
}

function handleGetPull(forge: Forge, owner: string, name: string, number: number): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const pull = forge.getPull(repo, number);
  if (pull === undefined) throw notFound('Not Found');
  return { status: 200, headers: {}, json: pullObject(forge, repo, pull) };
}

function handleListPullFiles(forge: Forge, owner: string, name: string, number: number): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const pull = forge.getPull(repo, number);
  if (pull === undefined) throw notFound('Not Found');
  const files = forge.pullRequestFiles(repo, pull).map((entry) => ({
    sha: entry.newOid ?? entry.oldOid ?? '',
    filename: entry.filename,
    status: entry.status,
    additions: entry.additions,
    deletions: entry.deletions,
    changes: entry.additions + entry.deletions,
    blob_url: `https://example.invalid/${owner}/${name}/blob/${pull.headRef}/${entry.filename}`,
    raw_url: `https://example.invalid/${owner}/${name}/raw/${pull.headRef}/${entry.filename}`,
  }));
  return { status: 200, headers: {}, json: files };
}

function handleMergePull(forge: Forge, request: RestRequest, owner: string, name: string, number: number): RestResponse {
  const repo = requireRepo(forge, owner, name);
  const pull = forge.getPull(repo, number);
  if (pull === undefined) throw notFound('Not Found');
  const body = parseBody(request);
  const method = stringField(body, 'merge_method') ?? 'merge';
  const result = forge.mergePull(repo, pull, method);
  if ('error' in result) {
    if (result.error === 'not-open') throw methodNotAllowed('Pull request is already closed');
    if (result.error === 'conflict') throw methodNotAllowed('Pull request has merge conflicts');
    throw methodNotAllowed('Pull request head or base branch is missing');
  }
  return {
    status: 200,
    headers: {},
    json: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' },
  };
}

/** A path segment that must be a positive integer issue/pull number. */
function issueNumber(segment: string): number {
  if (!/^\d+$/.test(segment)) throw notFound('Not Found');
  return Number.parseInt(segment, 10);
}

/** Dispatch one REST request. Unknown routes are 404 JSON, never HTML. */
export function handleRest(forge: Forge, request: RestRequest): RestResponse {
  const { method, segments } = request;
  try {
    if (segments.length === 0) {
      if (method === 'GET') return handleRoot(request);
      throw notFound();
    }
    const [first] = segments;
    if (first === 'meta' && segments.length === 1) {
      if (method === 'GET') return handleMeta();
      throw notFound();
    }
    if (first === 'user' && segments.length === 1) {
      if (method === 'GET') return { status: 200, headers: {}, json: userObject(VIEWER) };
      throw notFound();
    }
    if (first === 'user' && segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') return handleListUserRepos(forge, request);
      if (method === 'POST') return handleCreateRepo(forge, request);
      throw notFound();
    }
    if (first === 'users' && segments.length === 2) {
      if (method === 'GET') {
        const user = userByLogin(segments[1] as string);
        if (user === undefined) throw notFound('Not Found');
        return { status: 200, headers: {}, json: userObject(user) };
      }
      throw notFound();
    }
    if (first === 'repos' && segments.length >= 3) {
      const owner = segments[1] as string;
      const name = segments[2] as string;
      const rest = segments.slice(3);
      if (rest.length === 0) {
        if (method === 'GET') return handleGetRepo(forge, owner, name);
        if (method === 'PATCH') return handlePatchRepo(forge, request, owner, name);
        if (method === 'DELETE') return handleDeleteRepo(forge, owner, name);
        throw notFound();
      }
      const [resource] = rest;
      if (resource === 'branches') {
        if (rest.length === 1 && method === 'GET') return handleListBranches(forge, owner, name);
        if (rest.length >= 2 && method === 'GET') {
          return handleGetBranch(forge, owner, name, rest.slice(1).join('/'));
        }
        throw notFound();
      }
      if (resource === 'git' && rest[1] === 'refs') {
        if (rest.length === 2 && method === 'POST') return handleCreateRef(forge, request, owner, name);
        if (rest.length >= 3 && method === 'GET') return handleGetRef(forge, owner, name, rest.slice(2).join('/'));
        throw notFound();
      }
      if (resource === 'commits') {
        if (rest.length === 1 && method === 'GET') return handleListCommits(forge, request, owner, name);
        if (rest.length === 2 && method === 'GET') return handleGetCommit(forge, owner, name, rest[1] as string);
        throw notFound();
      }
      if (resource === 'contents') {
        const path = rest.slice(1).join('/');
        if (method === 'GET') return handleGetContents(forge, request, owner, name, path);
        if (method === 'PUT') return handlePutContents(forge, request, owner, name, path);
        if (method === 'DELETE') return handleDeleteContents(forge, request, owner, name, path);
        throw notFound();
      }
      if (resource === 'labels' && rest.length === 1) {
        if (method === 'GET') return handleListLabels(forge, owner, name);
        if (method === 'POST') return handleCreateLabel(forge, request, owner, name);
        throw notFound();
      }
      if (resource === 'issues') {
        if (rest.length === 1) {
          if (method === 'GET') return handleListIssues(forge, request, owner, name);
          if (method === 'POST') return handleCreateIssue(forge, request, owner, name);
          throw notFound();
        }
        const number = issueNumber(rest[1] as string);
        if (rest.length === 2) {
          if (method === 'GET') return handleGetIssue(forge, owner, name, number);
          if (method === 'PATCH') return handlePatchIssue(forge, request, owner, name, number);
          throw notFound();
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'GET') return handleListComments(forge, owner, name, number);
          if (method === 'POST') return handleCreateComment(forge, request, owner, name, number);
          throw notFound();
        }
        throw notFound();
      }
      if (resource === 'pulls') {
        if (rest.length === 1) {
          if (method === 'GET') return handleListPulls(forge, request, owner, name);
          if (method === 'POST') return handleCreatePull(forge, request, owner, name);
          throw notFound();
        }
        const number = issueNumber(rest[1] as string);
        if (rest.length === 2 && method === 'GET') return handleGetPull(forge, owner, name, number);
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          return handleListPullFiles(forge, owner, name, number);
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          return handleMergePull(forge, request, owner, name, number);
        }
        throw notFound();
      }
      throw notFound();
    }
    throw notFound();
  } catch (err) {
    if (err instanceof RestError) {
      return { status: err.status, headers: {}, json: { message: err.message } };
    }
    throw err;
  }
}
