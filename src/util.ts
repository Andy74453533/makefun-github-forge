// Small shared helpers: the deterministic clock, id counters, base64 and
// the opaque Relay-style global ids. Nothing here reads the wall clock or
// an unseeded random source: every observable value derives from the
// trial's fixed inputs plus counters that advance in request order, so a
// replay of the same requests produces the same bytes.

import { createHash } from 'node:crypto';

/** Fallback epoch (seconds) when the trial gives no time: the scenario epoch. */
export const FALLBACK_EPOCH_SEC = 1_735_689_600;

/** Parse MAKEFUN_TRIAL_NOW: epoch seconds, epoch millis, or an ISO string. */
export function trialNowSec(env: NodeJS.ProcessEnv): number {
  const raw = env.MAKEFUN_TRIAL_NOW;
  if (raw === undefined || raw === '') return FALLBACK_EPOCH_SEC;
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isSafeInteger(value)) {
      // Millis (13 digits) versus seconds (10 digits): tell them apart by size.
      return Math.abs(value) >= 1e12 ? Math.floor(value / 1000) : value;
    }
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return FALLBACK_EPOCH_SEC;
}

/**
 * A clock that only moves when asked: each tick returns the trial's base
 * time plus one more second. Creation order and commit order stay stable
 * and distinct, and a replay walks the same ticks in the same order.
 */
export class TickClock {
  private readonly baseSec: number;
  private ticks = 0;

  constructor(baseSec: number) {
    this.baseSec = baseSec;
  }

  /** The next timestamp, in epoch seconds. */
  nextSec(): number {
    this.ticks += 1;
    return this.baseSec + this.ticks;
  }

  /** The next timestamp as an ISO-8601 string. */
  nextIso(): string {
    return new Date(this.nextSec() * 1000).toISOString();
  }

  /** The base time without advancing, as an ISO-8601 string. */
  baseIso(): string {
    return new Date(this.baseSec * 1000).toISOString();
  }
}

/** A process-wide monotonic counter for X-GitHub-Request-Id values. */
let requestCounter = 0;

/** The next request id: deterministic, non-empty, unique within the process. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** SHA-1 of bytes, lowercase hex. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** True for a lowercase 40-hex object id. */
export function isHex40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Standard base64 of UTF-8 text. */
export function textToBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** UTF-8 text from standard base64 (whitespace tolerated, as GitHub wraps it). */
export function base64ToText(content: string): string {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

/** Standard base64 of bytes. */
export function bytesToBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Bytes from standard base64 (whitespace tolerated). */
export function base64ToBytes(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** The global-id kinds this forge mints for its GraphQL Node interface. */
export type GlobalIdKind = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User';

/**
 * An opaque global id: base64 of `Kind:part:part`. Stable for the same
 * record, never the plain database id or number.
 */
export function mintGlobalId(kind: GlobalIdKind, parts: readonly (string | number)[]): string {
  return textToBase64([kind, ...parts.map(String)].join(':'));
}

/** Decode a global id minted above, or null when it is not one. */
export function parseGlobalId(
  id: string,
): { kind: GlobalIdKind; parts: string[] } | null {
  if (typeof id !== 'string' || id === '' || id.length > 256) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  // Re-encoding must round-trip: rejects ids that merely decode to text.
  if (textToBase64(decoded) !== id) return null;
  const segments = decoded.split(':');
  const kind = segments[0];
  if (
    kind !== 'Repository' &&
    kind !== 'Issue' &&
    kind !== 'PullRequest' &&
    kind !== 'IssueComment' &&
    kind !== 'User'
  ) {
    return null;
  }
  return { kind, parts: segments.slice(1) };
}

/** Split text into lines the way a diff counts them (no phantom last line). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
