// The forge's store: every repository, object, ref, issue and pull
// request lives here, in memory, shared by the git, REST, GraphQL and MCP
// surfaces. One Forge instance serves one trial; nothing is persisted.
//
// Ordering and time come from a single tick clock and a single creation
// counter, so two runs fed the same requests produce the same records,
// the same ids and the same timestamps.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobjects.ts';
import { TickClock, isHex40, mintGlobalId, splitLines } from './util.ts';
import { VIEWER, forgeIdentity } from './scenario.ts';

export { ZERO_OID };

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

/** A record for one issue comment. */
export interface CommentRecord {
  readonly id: number;
  readonly body: string;
  readonly seq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A record for one label. */
export interface LabelRecord {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

/** A record for one issue (pull requests are separate records). */
export interface IssueRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: CommentRecord[];
}

/** A record for one pull request. */
export interface PullRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
  readonly comments: CommentRecord[];
}

/** A parsed commit header, cached so long histories stay cheap to walk. */
interface CommitHeader {
  readonly tree: string;
  readonly parents: readonly string[];
}

/** One repository: its objects, refs, issues, pulls and labels. */
export interface RepoRecord {
  readonly dbid: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects: Map<string, GitObject>;
  readonly commitHeaders: Map<string, CommitHeader>;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, IssueRecord>;
  readonly pulls: Map<number, PullRecord>;
  readonly labels: Map<string, LabelRecord>;
  nextNumber: number;
}

/** A flattened tree: every file path and the blob behind it. */
export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

/** One entry of a tree-to-tree diff. */
export interface DiffEntry {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** The outcome of a three-way merge computation. */
export interface MergeOutcome {
  readonly conflict: boolean;
  readonly conflicts: readonly string[];
  readonly treeOid: string | null;
}

/** One receive-pack ref command. */
export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly refName: string;
}

/** The per-ref outcome of a push, in command order. */
export interface PushResult {
  readonly refName: string;
  readonly ok: boolean;
  readonly reason: string | null;
}

/** Inputs to a fetch-plan computation. */
export interface FetchRequest {
  readonly wants: readonly string[];
  readonly haves: readonly string[];
  readonly shallow: readonly string[];
  readonly depth: number | null;
}

/** What a fetch must send, and what its shallow/ack sections must say. */
export interface FetchPlan {
  readonly objects: ReadonlyMap<string, GitObject>;
  readonly shallow: readonly string[];
  readonly unshallow: readonly string[];
  readonly acks: readonly string[];
  readonly nak: boolean;
}

/** A path read from a commit: a file, a directory, or nothing. */
export type PathRead =
  | { kind: 'file'; oid: string; mode: string; size: number; data: Buffer }
  | { kind: 'dir'; entries: TreeEntry[] }
  | null;

/**
 * The whole forge. Methods that change state take their inputs as plain
 * values and return plain results; the wire layers translate them into
 * HTTP, JSON-RPC and pkt-line responses.
 */
export class Forge {
  readonly clock: TickClock;
  private readonly reposByKey = new Map<string, RepoRecord>();
  private readonly reposByDbid = new Map<number, RepoRecord>();
  private nextDbid = 1;
  private nextRecordId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  private creationSeq = 0;

  constructor(baseSec: number) {
    this.clock = new TickClock(baseSec);
  }

  // ------------------------------------------------------------------ repos

  private key(owner: string, name: string): string {
    return `${owner}\u0000${name}`;
  }

  /** Create a repository; null when one with the same owner+name exists. */
  createRepo(
    owner: string,
    name: string,
    options: { description?: string; isPrivate?: boolean } = {},
  ): RepoRecord | null {
    const key = this.key(owner, name);
    if (this.reposByKey.has(key)) return null;
    this.creationSeq += 1;
    const now = this.clock.nextIso();
    const repo: RepoRecord = {
      dbid: this.nextDbid,
      name,
      owner,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      seq: this.creationSeq,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      commitHeaders: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.nextDbid += 1;
    this.reposByKey.set(key, repo);
    this.reposByDbid.set(repo.dbid, repo);
    return repo;
  }

  /** The repository at owner/name, or undefined. */
  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.reposByKey.get(this.key(owner, name));
  }

  /** The repository with this database id, or undefined. */
  getRepoByDbid(dbid: number): RepoRecord | undefined {
    return this.reposByDbid.get(dbid);
  }

  /** Delete a repository; false when it did not exist. */
  deleteRepo(owner: string, name: string): boolean {
    const repo = this.reposByKey.get(this.key(owner, name));
    if (repo === undefined) return false;
    this.reposByKey.delete(this.key(owner, name));
    this.reposByDbid.delete(repo.dbid);
    return true;
  }

  /** Every repository, in creation order. */
  listRepos(): RepoRecord[] {
    return [...this.reposByKey.values()].sort((a, b) => a.seq - b.seq);
  }

  /** The global id of a repository. */
  repoGlobalId(repo: RepoRecord): string {
    return mintGlobalId('Repository', [repo.dbid]);
  }

  /** The global id of an issue. */
  issueGlobalId(repo: RepoRecord, issue: IssueRecord): string {
    return mintGlobalId('Issue', [repo.dbid, issue.number]);
  }

  /** The global id of a pull request. */
  pullGlobalId(repo: RepoRecord, pull: PullRecord): string {
    return mintGlobalId('PullRequest', [repo.dbid, pull.number]);
  }

  /** The global id of a comment. */
  commentGlobalId(repo: RepoRecord, comment: CommentRecord): string {
    return mintGlobalId('IssueComment', [repo.dbid, comment.id]);
  }

  // ---------------------------------------------------------------- objects

  /** Store an object, returning its id. Commit headers are cached on the way in. */
  putObject(repo: RepoRecord, type: GitObjectType, data: Uint8Array): string {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const oid = hashObject(type, bytes);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data: bytes });
      if (type === 'commit') {
        const view = parseCommit(bytes);
        repo.commitHeaders.set(oid, { tree: view.tree, parents: view.parents });
      }
    }
    return oid;
  }

  /** Add objects that arrived in a pack (already resolved to full objects). */
  addObjects(repo: RepoRecord, objects: Iterable<[string, GitObject]>): void {
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) {
        repo.objects.set(oid, object);
        if (object.type === 'commit') {
          const view = parseCommit(object.data);
          repo.commitHeaders.set(oid, { tree: view.tree, parents: view.parents });
        }
      }
    }
  }

  /** The object with this id, or undefined. */
  getObject(repo: RepoRecord, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** A commit's cached header, or null when the id is not a commit. */
  commitHeader(repo: RepoRecord, oid: string): CommitHeader | null {
    const cached = repo.commitHeaders.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const view = parseCommit(object.data);
    const header = { tree: view.tree, parents: view.parents };
    repo.commitHeaders.set(oid, header);
    return header;
  }

  /** Follow tags to the object they name; null when the id is unknown or cyclic. */
  peel(repo: RepoRecord, oid: string): string | null {
    return peelToCommit(oid, (id) => repo.objects.get(id));
  }

  // -------------------------------------------------------------------- refs

  /** The tip a ref points at, or undefined. */
  getRef(repo: RepoRecord, refName: string): string | undefined {
    return repo.refs.get(refName);
  }

  /** Every ref, sorted by name. */
  listRefs(repo: RepoRecord): { name: string; oid: string }[] {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The default branch's tip, or undefined while the repository is unborn. */
  defaultTip(repo: RepoRecord): string | undefined {
    return repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  }

  /**
   * Resolve a branch name, a full ref name, or an object id to an object
   * id, or undefined. Branch names win over tags, as in git's own rules.
   */
  resolveRef(repo: RepoRecord, ref: string): string | undefined {
    if (ref === '') return undefined;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    if (isHex40(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  /** Create or update a ref directly (REST refs endpoint). */
  setRef(repo: RepoRecord, refName: string, oid: string): void {
    repo.refs.set(refName, oid);
  }

  /** Delete a ref; false when it did not exist. */
  deleteRef(repo: RepoRecord, refName: string): boolean {
    return repo.refs.delete(refName);
  }

  // ------------------------------------------------------------- trees/paths

  /** Every file in a tree, flattened to full paths. Gitlinks are skipped. */
  flattenTree(repo: RepoRecord, treeOid: string | null): Map<string, FlatEntry> {
    const flat = new Map<string, FlatEntry>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') flat.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    if (treeOid !== null) walk(treeOid, '');
    return flat;
  }

  /** Build (and store) the tree for a flat path map. */
  buildTreeFromFlat(repo: RepoRecord, flat: ReadonlyMap<string, FlatEntry>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, entry] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: build(childPrefix) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build('');
  }

  /**
   * Read a path out of a commit: a file's bytes, a directory's entries,
   * or null. `commitOid` is peeled to a commit first.
   */
  readPath(repo: RepoRecord, commitOid: string, path: string): PathRead {
    const peeled = this.peel(repo, commitOid);
    if (peeled === null) return null;
    const header = this.commitHeader(repo, peeled);
    if (header === null) return null;
    if (path === '') {
      const object = repo.objects.get(header.tree);
      if (object === undefined) return null;
      return { kind: 'dir', entries: parseTree(object.data) };
    }
    const segments = path.split('/').filter((segment) => segment !== '');
    let treeOid = header.tree;
    for (let index = 0; index < segments.length; index += 1) {
      const object = repo.objects.get(treeOid);
      if (object === undefined || object.type !== 'tree') return null;
      const entries = parseTree(object.data);
      const match = entries.find((entry) => entry.name === segments[index]);
      if (match === undefined) return null;
      const last = index === segments.length - 1;
      if (match.mode === '40000') {
        if (!last) {
          treeOid = match.oid;
          continue;
        }
        const dirObject = repo.objects.get(match.oid);
        if (dirObject === undefined || dirObject.type !== 'tree') return null;
        return { kind: 'dir', entries: parseTree(dirObject.data) };
      }
      if (!last) return null;
      const blob = repo.objects.get(match.oid);
      if (blob === undefined || blob.type !== 'blob') return null;
      return { kind: 'file', oid: match.oid, mode: match.mode, size: blob.data.length, data: blob.data };
    }
    return null;
  }

  /**
   * Set (or delete, when blobOid is null) one path in a tree, rebuilding
   * the ancestors. Empty directories left behind by a delete are pruned.
   */
  setPathInTree(
    repo: RepoRecord,
    treeOid: string | null,
    path: string,
    blobOid: string | null,
    mode: string = '100644',
  ): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const rewrite = (currentOid: string | null, depth: number): string | null => {
      const entries = new Map<string, TreeEntry>();
      if (currentOid !== null) {
        const object = repo.objects.get(currentOid);
        if (object !== undefined && object.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const segment = segments[depth] as string;
      const last = depth === segments.length - 1;
      if (last) {
        if (blobOid === null) entries.delete(segment);
        else entries.set(segment, { mode, name: segment, oid: blobOid });
      } else {
        const existing = entries.get(segment);
        const childOid = rewrite(existing?.mode === '40000' ? existing.oid : null, depth + 1);
        if (childOid === null) entries.delete(segment);
        else entries.set(segment, { mode: '40000', name: segment, oid: childOid });
      }
      if (entries.size === 0) return null;
      return this.putObject(repo, 'tree', buildTree([...entries.values()]));
    };
    return rewrite(treeOid, 0) ?? this.putObject(repo, 'tree', buildTree([]));
  }

  // ----------------------------------------------------------------- commits

  /** Create a commit the forge signs with the viewer's identity and the tick clock. */
  createCommit(
    repo: RepoRecord,
    fields: { tree: string; parents?: readonly string[]; message: string },
  ): string {
    const timestamp = this.clock.nextSec();
    const identity = forgeIdentity();
    const bytes = buildCommit({
      tree: fields.tree,
      parents: fields.parents ?? [],
      message: fields.message,
      author: identity,
      committer: identity,
      timestamp,
    });
    return this.putObject(repo, 'commit', bytes);
  }

  /** Every commit reachable from a tip, newest-first by walk order, deduplicated. */
  walkCommits(repo: RepoRecord, tipOid: string): string[] {
    const peeled = this.peel(repo, tipOid);
    if (peeled === null) return [];
    const order: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [peeled];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const header = this.commitHeader(repo, oid);
      if (header === null) continue;
      seen.add(oid);
      order.push(oid);
      // Parents pushed in reverse so the first parent is visited first.
      for (let index = header.parents.length - 1; index >= 0; index -= 1) {
        stack.push(header.parents[index] as string);
      }
    }
    return order;
  }

  /** True when `ancestor` is `descendant` or one of its ancestors (tags peeled). */
  isAncestor(repo: RepoRecord, ancestor: string, descendant: string): boolean {
    const from = this.peel(repo, descendant);
    const target = this.peel(repo, ancestor);
    if (from === null || target === null) return false;
    if (from === target) return true;
    const seen = new Set<string>();
    const stack: string[] = [from];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const header = this.commitHeader(repo, oid);
      if (header === null) continue;
      for (const parent of header.parents) {
        if (parent === target) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The merge base of two tips: the first commit of B's ancestry that A also reaches. */
  mergeBase(repo: RepoRecord, tipA: string, tipB: string): string | null {
    const a = this.peel(repo, tipA);
    const b = this.peel(repo, tipB);
    if (a === null || b === null) return null;
    const ancestorsOfA = new Set<string>();
    const stackA: string[] = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.add(oid);
      const header = this.commitHeader(repo, oid);
      if (header === null) continue;
      for (const parent of header.parents) stackA.push(parent);
    }
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const header = this.commitHeader(repo, oid);
      if (header === null) continue;
      for (const parent of header.parents) queue.push(parent);
    }
    return null;
  }

  // ------------------------------------------------------------- diff / merge

  /** Line counts for one changed file: additions and deletions via an LCS diff. */
  lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
    const oldLines = oldText === null ? [] : splitLines(oldText);
    const newLines = newText === null ? [] : splitLines(newText);
    if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
    if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
    if (oldLines.length * newLines.length > 25_000_000) {
      // Very large files: fall back to whole-file counts rather than a quadratic diff.
      return { additions: newLines.length, deletions: oldLines.length };
    }
    // LCS length by two-row dynamic programming.
    let previous = new Array<number>(newLines.length + 1).fill(0);
    let current = new Array<number>(newLines.length + 1).fill(0);
    for (let i = 1; i <= oldLines.length; i += 1) {
      current[0] = 0;
      for (let j = 1; j <= newLines.length; j += 1) {
        current[j] =
          oldLines[i - 1] === newLines[j - 1]
            ? (previous[j - 1] as number) + 1
            : Math.max(previous[j] as number, current[j - 1] as number);
      }
      [previous, current] = [current, previous];
    }
    const common = previous[newLines.length] as number;
    return { additions: newLines.length - common, deletions: oldLines.length - common };
  }

  /** Diff two trees (null = empty), sorted by filename. */
  diffTrees(repo: RepoRecord, oldTree: string | null, newTree: string | null): DiffEntry[] {
    const oldFlat = this.flattenTree(repo, oldTree);
    const newFlat = this.flattenTree(repo, newTree);
    const paths = new Set([...oldFlat.keys(), ...newFlat.keys()]);
    const entries: DiffEntry[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = oldFlat.get(path);
      const newEntry = newFlat.get(path);
      if (oldEntry === undefined && newEntry === undefined) continue;
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
      const oldText =
        oldEntry === undefined ? null : (repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? null);
      const newText =
        newEntry === undefined ? null : (repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? null);
      const counts = this.lineCounts(oldText, newText);
      entries.push({
        filename: path,
        status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        oldOid: oldEntry?.oid ?? null,
        newOid: newEntry?.oid ?? null,
      });
    }
    return entries;
  }

  /** The files a pull request changes: merge-base tree versus head tree. */
  pullRequestFiles(repo: RepoRecord, pull: PullRecord): DiffEntry[] {
    const headTip = this.getRef(repo, `refs/heads/${pull.headRef}`);
    const baseTip = this.getRef(repo, `refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseTree = base === null ? null : (this.commitHeader(repo, base)?.tree ?? null);
    const headTree = this.commitHeader(repo, this.peel(repo, headTip) ?? '')?.tree ?? null;
    return this.diffTrees(repo, baseTree, headTree);
  }

  /**
   * A three-way merge of head into base: every path changed on one side is
   * taken, a path changed differently on both sides conflicts, and a path
   * modified on one side and deleted on the other conflicts.
   */
  threeWayMerge(repo: RepoRecord, baseTip: string, headTip: string): MergeOutcome {
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseTree = base === null ? null : (this.commitHeader(repo, base)?.tree ?? null);
    const oursTip = this.peel(repo, baseTip);
    const theirsTip = this.peel(repo, headTip);
    const oursTree = oursTip === null ? null : (this.commitHeader(repo, oursTip)?.tree ?? null);
    const theirsTree = theirsTip === null ? null : (this.commitHeader(repo, theirsTip)?.tree ?? null);
    const baseFlat = this.flattenTree(repo, baseTree);
    const oursFlat = this.flattenTree(repo, oursTree);
    const theirsFlat = this.flattenTree(repo, theirsTree);
    const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
    const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean =>
      a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode;
    const conflicts: string[] = [];
    const merged = new Map(oursFlat);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const o = oursFlat.get(path);
      const t = theirsFlat.get(path);
      const oursChanged = !same(o, b);
      const theirsChanged = !same(t, b);
      if (!theirsChanged) continue;
      if (!oursChanged) {
        if (t === undefined) merged.delete(path);
        else merged.set(path, t);
        continue;
      }
      if (same(o, t)) continue;
      conflicts.push(path);
    }
    if (conflicts.length > 0) {
      return { conflict: true, conflicts: conflicts.sort(), treeOid: null };
    }
    return { conflict: false, conflicts: [], treeOid: this.buildTreeFromFlat(repo, merged) };
  }

  // -------------------------------------------------------------------- push

  /**
   * Apply receive-pack commands in order, after the pack's objects have
   * been added. Objects stay even when every ref update is refused.
   */
  applyPush(repo: RepoRecord, commands: readonly PushCommand[]): PushResult[] {
    const results: PushResult[] = [];
    for (const command of commands) {
      const { oldOid, newOid, refName } = command;
      const current = repo.refs.get(refName);
      if (newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ refName, ok: false, reason: 'remote ref does not exist' });
        } else if (oldOid !== ZERO_OID && oldOid !== current) {
          results.push({ refName, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(refName);
          results.push({ refName, ok: true, reason: null });
        }
        continue;
      }
      if (!repo.objects.has(newOid)) {
        results.push({ refName, ok: false, reason: `object ${newOid} is not in the store` });
        continue;
      }
      if (current === undefined) {
        // Create: old must be zero (a create that names an old value is stale).
        if (oldOid !== ZERO_OID) {
          results.push({ refName, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.set(refName, newOid);
          results.push({ refName, ok: true, reason: null });
        }
        continue;
      }
      if (oldOid !== ZERO_OID && oldOid !== current) {
        results.push({ refName, ok: false, reason: 'old value does not match' });
        continue;
      }
      // Update: must be a fast-forward (tags peeled to their commits).
      if (newOid === current || this.isAncestor(repo, current, newOid)) {
        repo.refs.set(refName, newOid);
        results.push({ refName, ok: true, reason: null });
      } else {
        results.push({ refName, ok: false, reason: 'non-fast-forward' });
      }
    }
    return results;
  }

  // ------------------------------------------------------------------- fetch

  /**
   * Compute what a fetch must deliver: the want closure cut at the depth
   * limit and at the client's shallow boundary, minus what the client
   * already holds (its own have closure, also cut at its shallow
   * boundary). Boundary commits are reported as shallow; shallow commits
   * whose parents are now all available are reported as unshallow.
   */
  computeFetch(repo: RepoRecord, request: FetchRequest): FetchPlan {
    const shallowSet = new Set(request.shallow);
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);

    // The client's holdings: haves, cut at the shallow boundary.
    const haveSet = new Set<string>();
    {
      const queue: string[] = [...request.haves];
      while (queue.length > 0) {
        const oid = queue.pop() as string;
        if (haveSet.has(oid)) continue;
        const object = lookup(oid);
        if (object === undefined) continue;
        haveSet.add(oid);
        if (object.type === 'tag') {
          queue.push(parseTag(object.data).object);
        } else if (object.type === 'tree') {
          for (const entry of parseTree(object.data)) {
            if (entry.mode !== '160000') queue.push(entry.oid);
          }
        } else if (object.type === 'commit') {
          const header = this.commitHeader(repo, oid);
          if (header === null) continue;
          queue.push(header.tree);
          // A shallow commit's parents stay unknown to the client.
          if (!shallowSet.has(oid)) {
            for (const parent of header.parents) queue.push(parent);
          }
        }
      }
    }

    // The want walk: commits at their distance from the nearest want.
    const included = new Set<string>();
    const commitDistance = new Map<string, number>();
    const boundary = new Set<string>();
    const depth = request.depth;
    {
      const queue: { oid: string; distance: number }[] = [];
      const tagObjects: string[] = [];
      for (const want of request.wants) {
        const object = lookup(want);
        if (object === undefined) continue;
        if (object.type === 'tag') {
          tagObjects.push(want);
          const peeled = this.peel(repo, want);
          if (peeled !== null) queue.push({ oid: peeled, distance: 0 });
        } else if (object.type === 'commit') {
          queue.push({ oid: want, distance: 0 });
        } else {
          // A blob or tree want: include it and its closure directly.
          for (const oid of collectReachable([want], lookup, { allowMissing: true })) {
            included.add(oid);
          }
        }
      }
      for (const tagOid of tagObjects) {
        included.add(tagOid);
        // Nested tags: peel chains contribute every tag object.
        let current = tagOid;
        const seenTags = new Set<string>();
        for (;;) {
          if (seenTags.has(current)) break;
          seenTags.add(current);
          const object = lookup(current);
          if (object === undefined || object.type !== 'tag') break;
          const target = parseTag(object.data).object;
          const targetObject = lookup(target);
          if (targetObject !== undefined && targetObject.type === 'tag') included.add(target);
          current = target;
        }
      }
      const seenCommits = new Set<string>();
      while (queue.length > 0) {
        const { oid, distance } = queue.shift() as { oid: string; distance: number };
        const known = commitDistance.get(oid);
        if (known !== undefined && known <= distance) continue;
        commitDistance.set(oid, distance);
        const header = this.commitHeader(repo, oid);
        if (header === null) continue;
        seenCommits.add(oid);
        included.add(oid);
        // The commit's tree closure always travels with the commit.
        for (const treeOid of collectReachable([header.tree], lookup, { allowMissing: true })) {
          included.add(treeOid);
        }
        const atDepthLimit = depth !== null && distance + 1 >= depth;
        const cutAtShallow = depth === null && shallowSet.has(oid);
        if (header.parents.length === 0) continue;
        if (atDepthLimit || cutAtShallow) {
          boundary.add(oid);
          continue;
        }
        for (const parent of header.parents) {
          queue.push({ oid: parent, distance: distance + 1 });
        }
      }
      void seenCommits;
    }

    // What to send: the want closure minus the client's holdings.
    const objects = new Map<string, GitObject>();
    for (const oid of [...included].sort()) {
      if (haveSet.has(oid)) continue;
      const object = lookup(oid);
      if (object !== undefined) objects.set(oid, object);
    }

    // Shallow: boundary commits, sorted for a stable response.
    const shallow = [...boundary].sort();

    // Unshallow: the client's shallow commits that left the boundary and
    // whose parents are now all in the client's hands (held or delivered).
    const available = new Set([...haveSet, ...objects.keys()]);
    const unshallow: string[] = [];
    for (const oid of [...shallowSet].sort()) {
      if (boundary.has(oid)) continue;
      const header = this.commitHeader(repo, oid);
      if (header === null) continue;
      if (header.parents.every((parent) => available.has(parent))) {
        unshallow.push(oid);
      }
    }

    // Acknowledgements: haves that are ancestors of a want (full ancestry).
    const ancestorsOfWants = new Set<string>();
    {
      const queue: string[] = [];
      for (const want of request.wants) {
        const peeled = this.peel(repo, want);
        if (peeled !== null) queue.push(peeled);
      }
      while (queue.length > 0) {
        const oid = queue.pop() as string;
        if (ancestorsOfWants.has(oid)) continue;
        ancestorsOfWants.add(oid);
        const header = this.commitHeader(repo, oid);
        if (header === null) continue;
        for (const parent of header.parents) queue.push(parent);
      }
    }
    const acks = request.haves.filter((have) => ancestorsOfWants.has(have) && repo.objects.has(have));
    const nak = request.haves.length > 0 && acks.length === 0;

    return { objects, shallow, unshallow, acks, nak };
  }

  // ------------------------------------------------------------------ labels

  /** Create a label, or return the existing one with the same name. */
  createLabel(repo: RepoRecord, name: string, color: string | undefined): LabelRecord {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: LabelRecord = { id: this.nextLabelId, name, color: color ?? 'ededed' };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  /** Every label, in creation order. */
  listLabels(repo: RepoRecord): LabelRecord[] {
    return [...repo.labels.values()].sort((a, b) => a.id - b.id);
  }

  // ------------------------------------------------------------------ issues

  /** Create an issue; unknown label names are rejected by the caller first. */
  createIssue(
    repo: RepoRecord,
    fields: { title: string; body?: string; labels?: readonly string[] },
  ): IssueRecord {
    this.creationSeq += 1;
    const now = this.clock.nextIso();
    const issue: IssueRecord = {
      id: this.nextRecordId,
      number: repo.nextNumber,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      labels: [...(fields.labels ?? [])],
      seq: this.creationSeq,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.nextRecordId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  /** The issue with this number, or undefined. */
  getIssue(repo: RepoRecord, number: number): IssueRecord | undefined {
    return repo.issues.get(number);
  }

  /** Issues filtered by state and sorted by creation order. */
  listIssues(
    repo: RepoRecord,
    options: { state?: string; sort?: string; direction?: string } = {},
  ): IssueRecord[] {
    const state = options.state ?? 'open';
    const direction = options.direction ?? 'desc';
    let issues = [...repo.issues.values()];
    if (state !== 'all') {
      issues = issues.filter((issue) => issue.state === state);
    }
    issues.sort((a, b) => {
      const bySeq = a.seq - b.seq;
      if (bySeq !== 0) return direction === 'asc' ? bySeq : -bySeq;
      return direction === 'asc' ? a.number - b.number : b.number - a.number;
    });
    return issues;
  }

  /** Update an issue's fields; unknown label names are rejected by the caller first. */
  updateIssue(
    repo: RepoRecord,
    issue: IssueRecord,
    patch: { title?: string; body?: string; state?: 'open' | 'closed'; labels?: readonly string[] },
  ): IssueRecord {
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.labels !== undefined) issue.labels = [...patch.labels];
    issue.updatedAt = this.clock.nextIso();
    void repo;
    return issue;
  }

  /** Add a comment to an issue or a pull request. */
  addComment(
    record: IssueRecord | PullRecord,
    body: string,
  ): CommentRecord {
    this.creationSeq += 1;
    const now = this.clock.nextIso();
    const comment: CommentRecord = {
      id: this.nextCommentId,
      body,
      seq: this.creationSeq,
      createdAt: now,
      updatedAt: now,
    };
    this.nextCommentId += 1;
    record.comments.push(comment);
    record.updatedAt = now;
    return comment;
  }

  // -------------------------------------------------------------------- pulls

  /** Create a pull request; branch existence and duplicates are checked by the caller. */
  createPull(
    repo: RepoRecord,
    fields: { title: string; body?: string; headRef: string; baseRef: string },
  ): PullRecord {
    this.creationSeq += 1;
    const now = this.clock.nextIso();
    const pull: PullRecord = {
      id: this.nextRecordId,
      number: repo.nextNumber,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: fields.headRef,
      baseRef: fields.baseRef,
      seq: this.creationSeq,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.nextRecordId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The pull request with this number, or undefined. */
  getPull(repo: RepoRecord, number: number): PullRecord | undefined {
    return repo.pulls.get(number);
  }

  /** Pull requests filtered by state, newest first. */
  listPulls(repo: RepoRecord, state: string = 'open'): PullRecord[] {
    let pulls = [...repo.pulls.values()];
    if (state !== 'all') {
      pulls = pulls.filter((pull) => pull.state === state);
    }
    pulls.sort((a, b) => b.seq - a.seq || b.number - a.number);
    return pulls;
  }

  /** An open pull request with the same head and base, or undefined. */
  findOpenPull(repo: RepoRecord, headRef: string, baseRef: string): PullRecord | undefined {
    return [...repo.pulls.values()].find(
      (pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef,
    );
  }

  /** A pull request's head/base tips, live from the refs. */
  pullTips(
    repo: RepoRecord,
    pull: PullRecord,
  ): { headSha: string | null; baseSha: string | null } {
    return {
      headSha: this.getRef(repo, `refs/heads/${pull.headRef}`) ?? null,
      baseSha: this.getRef(repo, `refs/heads/${pull.baseRef}`) ?? null,
    };
  }

  /** Whether a pull request can merge cleanly right now. */
  pullMergeable(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' {
    const tips = this.pullTips(repo, pull);
    if (tips.headSha === null || tips.baseSha === null) return 'CONFLICTING';
    return this.threeWayMerge(repo, tips.baseSha, tips.headSha).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Merge a pull request. Returns the merge commit's id, or a reason the
   * merge cannot happen: 'not-open' for a closed pull, 'conflict' for a
   * conflicting one, 'missing-branch' when a branch went away.
   */
  mergePull(
    repo: RepoRecord,
    pull: PullRecord,
    method: string,
  ): { sha: string } | { error: 'not-open' | 'conflict' | 'missing-branch' } {
    if (pull.state !== 'open') return { error: 'not-open' };
    const tips = this.pullTips(repo, pull);
    if (tips.headSha === null || tips.baseSha === null) return { error: 'missing-branch' };
    const outcome = this.threeWayMerge(repo, tips.baseSha, tips.headSha);
    if (outcome.conflict || outcome.treeOid === null) return { error: 'conflict' };
    const squash = method === 'squash' || method === 'rebase';
    const parents = squash ? [tips.baseSha] : [tips.baseSha, tips.headSha];
    const message = squash
      ? `${pull.title} (#${pull.number})`
      : `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const sha = this.createCommit(repo, { tree: outcome.treeOid, parents, message });
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.clock.nextIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return { sha };
  }

  // ---------------------------------------------------------------- contents

  /**
   * Write a file through the contents flow: create or update, on the
   * named branch (created from the default tip when it does not exist),
   * with an optimistic-concurrency check on the blob id when one is
   * given. Returns the commit and blob ids, or a failure reason.
   */
  putContent(
    repo: RepoRecord,
    fields: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { commitSha: string; blobSha: string; created: boolean } | { error: 'conflict' } {
    const branch = fields.branch ?? DEFAULT_BRANCH;
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName);
    if (tip === undefined && branch !== DEFAULT_BRANCH) {
      tip = this.defaultTip(repo);
      if (tip !== undefined) repo.refs.set(refName, tip);
    }
    const blobSha = this.putObject(repo, 'blob', fields.content);
    let created = true;
    let parentTree: string | null = null;
    let parents: string[] = [];
    if (tip !== undefined) {
      const peeled = this.peel(repo, tip);
      const header = peeled === null ? null : this.commitHeader(repo, peeled);
      if (header !== null) {
        parentTree = header.tree;
        parents = [tip];
        const existing = this.readPath(repo, tip, fields.path);
        if (existing !== null && existing.kind === 'file') {
          created = false;
          if (fields.sha !== undefined && fields.sha !== existing.oid) {
            return { error: 'conflict' };
          }
        }
      }
    }
    const treeOid = this.setPathInTree(repo, parentTree, fields.path, blobSha);
    const commitSha = this.createCommit(repo, { tree: treeOid, parents, message: fields.message });
    repo.refs.set(refName, commitSha);
    return { commitSha, blobSha, created };
  }

  /**
   * Delete a file through the contents flow. Returns the commit id, or a
   * failure reason: 'not-found' when the file is absent, 'conflict' when
   * the given blob id is stale.
   */
  deleteContent(
    repo: RepoRecord,
    fields: { path: string; message: string; branch?: string; sha?: string },
  ): { commitSha: string } | { error: 'not-found' | 'conflict' } {
    const branch = fields.branch ?? DEFAULT_BRANCH;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) return { error: 'not-found' };
    const existing = this.readPath(repo, tip, fields.path);
    if (existing === null || existing.kind !== 'file') return { error: 'not-found' };
    if (fields.sha !== undefined && fields.sha !== existing.oid) return { error: 'conflict' };
    const peeled = this.peel(repo, tip);
    const header = peeled === null ? null : this.commitHeader(repo, peeled);
    const treeOid = this.setPathInTree(repo, header?.tree ?? null, fields.path, null);
    const commitSha = this.createCommit(repo, { tree: treeOid, parents: [tip], message: fields.message });
    repo.refs.set(refName, commitSha);
    return { commitSha };
  }
}
