// The git smart-HTTP surface: info/refs advertisements, upload-pack
// (protocol v2 plus the v0 fallback) and receive-pack (v0 only). Pkt-lines,
// sideband framing and packfiles are built here; object storage, ref
// rules and fetch planning live in the store.

import { PackError, ZERO_OID, readPack, writePack, type GitObject } from './gitobjects.ts';
import { Forge, DEFAULT_BRANCH, type PushCommand, type RepoRecord } from './store.ts';

/** The agent string the forge advertises in capability lists. */
export const AGENT = 'github-forge/1.0.0';

/**
 * Per-repo caches of fully-built git responses, keyed by repo version +
 * request. The 50 concurrent clones of one repo ask for the same fetch,
 * ls-refs and advertisement over and over: the first builds the bytes,
 * the rest reuse them. Entries are derived purely from repo state, so a
 * version bump (any object or ref change) retires them; they are never
 * part of the store or its export.
 */
interface GitResponseCache {
  fetch: Map<string, Buffer>;
  refs: Map<string, Buffer>;
}
const gitCaches = new WeakMap<RepoRecord, GitResponseCache>();
const GIT_CACHE_MAX = 32;
function gitCacheFor(repo: RepoRecord): GitResponseCache {
  let cache = gitCaches.get(repo);
  if (cache === undefined) {
    cache = { fetch: new Map(), refs: new Map() };
    gitCaches.set(repo, cache);
  }
  return cache;
}
function cachePut(cache: Map<string, Buffer>, key: string, value: Buffer): void {
  if (cache.size >= GIT_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

/** An HTTP error the git handlers raise: status plus a short body. */
export class GitHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHttpError';
    this.status = status;
  }
}

// ------------------------------------------------------------------ pkt-lines

/** One parsed pkt-line: data, a flush, a delim, or a response-end marker. */
type PktLine =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode text (or bytes) as one pkt-line. */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new PackError(`pkt-line of ${length} bytes exceeds the limit`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet, '0000'. */
function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet, '0001'. */
function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * Parse pkt-lines from the start of a buffer. Stops at the first flush,
 * delim or response-end marker (returned as a line) and reports how many
 * bytes were consumed, so a caller can treat the remainder as pack data.
 */
function parsePktLines(buffer: Buffer, start = 0): { lines: PktLine[]; next: number } {
  const lines: PktLine[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new PackError('pkt-line header is truncated');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (header === '0000') {
      lines.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (header === '0001') {
      lines.push({ kind: 'delim' });
      offset += 4;
      break;
    }
    if (header === '0002') {
      lines.push({ kind: 'response-end' });
      offset += 4;
      break;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      throw new PackError(`pkt-line header ${JSON.stringify(header)} is not hexadecimal`);
    }
    const length = parseInt(header, 16);
    if (length < 4) throw new PackError(`pkt-line length ${length} is below the header size`);
    if (offset + length > buffer.length) throw new PackError('pkt-line body is truncated');
    lines.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { lines, next: offset };
}

/** Parse every pkt-line in a buffer (used for request bodies with no pack tail). */
function parseAllPktLines(buffer: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const parsed = parsePktLines(buffer, offset);
    lines.push(...parsed.lines);
    if (parsed.next === offset) throw new PackError('pkt-line parsing made no progress');
    offset = parsed.next;
  }
  return lines;
}

/** The text of data pkt-lines, with trailing newlines stripped. */
function lineTexts(lines: readonly PktLine[]): string[] {
  const texts: string[] = [];
  for (const line of lines) {
    if (line.kind === 'data') texts.push(line.data.toString('utf8').replace(/\n$/, ''));
  }
  return texts;
}

/** Wrap bytes in one sideband packet on the given band (1 = data, 2 = progress). */
function sideband(band: 1 | 2, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a pack into sideband band-1 packets, each comfortably under the pkt-line limit. */
function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(sideband(1, pack.subarray(offset, offset + CHUNK)));
  }
  if (packets.length === 0) packets.push(sideband(1, Buffer.alloc(0)));
  return packets;
}

// --------------------------------------------------------------- info / refs

/** The refs a repository advertises, with tag peeling for annotated tags. */
function advertisedRefs(
  forge: Forge,
  repo: RepoRecord,
): { name: string; oid: string; peeled: string | null }[] {
  return forge.listRefs(repo).map((ref) => {
    const object = forge.getObject(repo, ref.oid);
    let peeled: string | null = null;
    if (object !== undefined && object.type === 'tag') {
      peeled = forge.peel(repo, ref.oid);
    }
    return { name: ref.name, oid: ref.oid, peeled };
  });
}

/** The v0 upload-pack advertisement (also used when the client sends no version header). */
function v0UploadAdvertisement(forge: Forge, repo: RepoRecord): Buffer {
  const caps = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), flushPkt()];
  const refs = advertisedRefs(forge, repo);
  const tip = forge.defaultTip(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const lines: string[] = [];
    if (tip !== undefined) lines.push(`${tip} HEAD`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}`);
      if (ref.peeled !== null) lines.push(`${ref.peeled} ${ref.name}^{}`);
    }
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\u0000${caps}\n` : `${line}\n`));
    });
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** The protocol-v2 advertisement never varies: build it once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('fetch=shallow\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${AGENT}\n`),
  flushPkt(),
]);

/** The protocol-v2 advertisement. */
function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** The v0 receive-pack advertisement (receive-pack never speaks v2 here). */
function v0ReceiveAdvertisement(forge: Forge, repo: RepoRecord): Buffer {
  const caps = `report-status side-band-64k delete-refs agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), flushPkt()];
  const refs = advertisedRefs(forge, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = `${ref.oid} ${ref.name}`;
      parts.push(pktLine(index === 0 ? `${line}\u0000${caps}\n` : `${line}\n`));
      if (ref.peeled !== null) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** Answer GET info/refs for one of the two services. */
export function handleInfoRefs(
  forge: Forge,
  repo: RepoRecord,
  service: string,
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  if (service === 'git-upload-pack') {
    if (gitProtocol !== undefined && gitProtocol.split(',').map((part) => part.trim()).includes('version=2')) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
    }
    const cache = gitCacheFor(repo).refs;
    const key = `v${repo.version}|upload-v0`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: hit };
    }
    const body = v0UploadAdvertisement(forge, repo);
    cachePut(cache, key, body);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-receive-pack') {
    const cache = gitCacheFor(repo).refs;
    const key = `v${repo.version}|receive-v0`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: hit };
    }
    const body = v0ReceiveAdvertisement(forge, repo);
    cachePut(cache, key, body);
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body };
  }
  throw new GitHttpError(400, `unknown service ${JSON.stringify(service)}`);
}

// --------------------------------------------------------------- upload-pack

/** Handle a v2 ls-refs command. */
function handleLsRefs(
  forge: Forge,
  repo: RepoRecord,
  args: readonly string[],
): Buffer {
  const cache = gitCacheFor(repo).refs;
  const key = `v${repo.version}|ls-refs|${args.join('\n')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const body = buildLsRefs(forge, repo, args);
  cachePut(cache, key, body);
  return body;
}

/** Build a v2 ls-refs reply (uncached). */
function buildLsRefs(
  forge: Forge,
  repo: RepoRecord,
  args: readonly string[],
): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const refs = advertisedRefs(forge, repo);
  const parts: Buffer[] = [];
  // HEAD is a ref named "HEAD": it is listed when no prefix filters apply
  // or when a prefix matches it (clients ask for it with `ref-prefix HEAD`).
  const headWanted = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headWanted) {
    const tip = forge.defaultTip(repo);
    if (tip !== undefined) {
      const suffix = wantSymrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : '';
      parts.push(pktLine(`${tip} HEAD${suffix}\n`));
    } else if (wantUnborn) {
      const suffix = wantSymrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : '';
      parts.push(pktLine(`unborn HEAD${suffix}\n`));
    }
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.peeled !== null) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** Handle a v2 fetch command. */
function handleV2Fetch(forge: Forge, repo: RepoRecord, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallows.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const parsed = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) depth = parsed;
    }
    // thin-pack, no-progress, ofs-delta, filter and friends: accepted, ignored.
  }
  const cache = gitCacheFor(repo).fetch;
  const key = `v${repo.version}|fetch-v2|${wants.join(',')}|${haves.join(',')}|${shallows.join(',')}|${depth ?? ''}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const body = buildV2Fetch(forge, repo, wants, haves, shallows, depth);
  cachePut(cache, key, body);
  return body;
}

/** Build a v2 fetch reply (uncached). */
function buildV2Fetch(
  forge: Forge,
  repo: RepoRecord,
  wants: readonly string[],
  haves: readonly string[],
  shallows: readonly string[],
  depth: number | null,
): Buffer {
  const plan = forge.computeFetch(repo, { wants, haves, shallow: shallows, depth });
  const parts: Buffer[] = [];
  // Each section opens with its header line and closes with a delim.
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'));
    parts.push(delimPkt());
  }
  const shallowInPlay =
    plan.shallow.length > 0 || plan.unshallow.length > 0 || depth !== null || shallows.length > 0;
  if (shallowInPlay) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(delimPkt());
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack([...plan.objects.values()]);
  parts.push(...sidebandPack(pack));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** Handle a v0 fetch request body. */
function handleV0Fetch(forge: Forge, repo: RepoRecord, lines: readonly PktLine[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  for (const text of lineTexts(lines)) {
    // The first want line carries capabilities after the oid, separated
    // by spaces (v0 has no NUL separator on want lines); the oid is the
    // first token after the verb on every line here.
    const clean = text.split('\u0000')[0] as string;
    const firstToken = (rest: string): string => rest.trim().split(/\s+/)[0] ?? '';
    if (clean.startsWith('want ')) wants.push(firstToken(clean.slice(5)));
    else if (clean.startsWith('have ')) haves.push(firstToken(clean.slice(5)));
    else if (clean.startsWith('shallow ')) shallows.push(firstToken(clean.slice(8)));
    else if (clean.startsWith('deepen ')) {
      const parsed = Number.parseInt(firstToken(clean.slice(7)), 10);
      if (Number.isInteger(parsed) && parsed > 0) depth = parsed;
    }
  }
  const cache = gitCacheFor(repo).fetch;
  const key = `v${repo.version}|fetch-v0|${wants.join(',')}|${haves.join(',')}|${shallows.join(',')}|${depth ?? ''}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const body = buildV0Fetch(forge, repo, wants, haves, shallows, depth);
  cachePut(cache, key, body);
  return body;
}

/** Build a v0 fetch reply (uncached). */
function buildV0Fetch(
  forge: Forge,
  repo: RepoRecord,
  wants: readonly string[],
  haves: readonly string[],
  shallows: readonly string[],
  depth: number | null,
): Buffer {
  const plan = forge.computeFetch(repo, { wants, haves, shallow: shallows, depth });
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const pack = writePack([...plan.objects.values()]);
  parts.push(...sidebandPack(pack));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

/** Answer POST git-upload-pack: v2 when the body opens with a command, else v0. */
export function handleUploadPack(
  forge: Forge,
  repo: RepoRecord,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  let lines: PktLine[];
  try {
    lines = parseAllPktLines(body);
  } catch (err) {
    if (err instanceof PackError) throw new GitHttpError(400, `malformed upload-pack request: ${err.message}`);
    throw err;
  }
  const texts = lineTexts(lines);
  if (texts.length === 0) throw new GitHttpError(400, 'malformed upload-pack request: empty body');
  const first = texts[0] as string;
  let response: Buffer;
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length);
    // Arguments run between the delim and the flush; anything after the
    // first delim is an argument line.
    const args: string[] = [];
    let pastDelim = false;
    for (const line of lines) {
      if (line.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (line.kind === 'data' && pastDelim) {
        args.push(line.data.toString('utf8').replace(/\n$/, ''));
      }
    }
    if (command === 'ls-refs') response = handleLsRefs(forge, repo, args);
    else if (command === 'fetch') response = handleV2Fetch(forge, repo, args);
    else throw new GitHttpError(400, `unknown upload-pack command ${JSON.stringify(command)}`);
  } else {
    response = handleV0Fetch(forge, repo, lines);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: response };
}

// -------------------------------------------------------------- receive-pack

/** Answer POST git-receive-pack: unpack, then apply the ref commands in order. */
export function handleReceivePack(
  forge: Forge,
  repo: RepoRecord,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  let parsed: { lines: PktLine[]; next: number };
  try {
    parsed = parsePktLines(body, 0);
  } catch (err) {
    if (err instanceof PackError) throw new GitHttpError(400, `malformed receive-pack request: ${err.message}`);
    throw err;
  }
  const commands: PushCommand[] = [];
  for (const text of lineTexts(parsed.lines)) {
    const clean = text.split('\u0000')[0] as string;
    const parts = clean.split(' ');
    if (parts.length !== 3) {
      throw new GitHttpError(400, `malformed receive-pack command ${JSON.stringify(clean)}`);
    }
    const [oldOid, newOid, refName] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid) || !refName.startsWith('refs/')) {
      throw new GitHttpError(400, `malformed receive-pack command ${JSON.stringify(clean)}`);
    }
    commands.push({ oldOid, newOid, refName });
  }
  const packBytes = body.subarray(parsed.next);

  // The report-status stream is itself pkt-line framed (one pkt-line per
  // report line, plus a flush), and that whole stream travels inside
  // sideband band-1 packets; an outer flush ends the sideband stream.
  // Sending the lines as raw sideband text breaks the reader, which
  // parses the demuxed band-1 bytes as pkt-lines.
  const report = (lines: string[]): Buffer => {
    const stream = Buffer.concat([
      ...lines.map((line) => pktLine(`${line}\n`)),
      flushPkt(),
    ]);
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < stream.length; offset += CHUNK) {
      parts.push(sideband(1, stream.subarray(offset, offset + CHUNK)));
    }
    parts.push(flushPkt());
    return Buffer.concat(parts);
  };

  if (packBytes.length > 0) {
    let objects: Map<string, GitObject>;
    try {
      objects = readPack(packBytes, { resolveBase: (oid) => forge.getObject(repo, oid) });
    } catch (err) {
      if (err instanceof PackError) {
        return {
          status: 200,
          contentType: 'application/x-git-receive-pack-result',
          body: report([`unpack ${err.message}`]),
        };
      }
      throw err;
    }
    forge.addObjects(repo, objects);
  }

  const results = forge.applyPush(repo, commands);
  const lines = ['unpack ok'];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.refName}` : `ng ${result.refName} ${result.reason ?? 'failed'}`);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: report(lines) };
}
