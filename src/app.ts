// The HTTP shell: one server, four surfaces. It reads each request body,
// enforces the bearer token on everything but /healthz, routes to the
// git, REST, GraphQL or MCP layer, and frames every reply with a request
// id and an explicit Content-Length so keep-alive connections stay fast.
//
// Fast paths (the timed workloads are thousands of small requests):
// request URLs are split by hand instead of `new URL()`; a request that
// cannot carry a body is dispatched synchronously, without waiting for
// the stream's end event; path segments skip decoding when they hold no
// escape. Each preserves the exact replies of the slow path.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { Forge } from './store.ts';
import { GitHttpError, handleInfoRefs, handleReceivePack, handleUploadPack } from './gitserver.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { nextRequestId } from './util.ts';

/** What the app needs: the store and the bearer token to enforce. */
export interface AppOptions {
  readonly forge: Forge;
  /** The expected bearer token. Empty means no token was configured: auth is skipped. */
  readonly token: string;
}

/** The largest request body accepted (packs stay far below this). */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** The empty body every bodyless request shares. */
const EMPTY_BODY = Buffer.alloc(0);

/** One shared empty query set: callers only read from it. */
const EMPTY_PARAMS = new URLSearchParams();

/** Read a request body fully, or null when it exceeds the cap. */
function readBody(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    request.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!tooBig) resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

/** Send a response with a request id, a content type and an explicit length. */
function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  response.end(body);
}

/** Send a JSON response. */
function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = value === null && status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value), 'utf8');
  send(response, status, 'application/json', body, extraHeaders);
}

/**
 * Split a request URL into its pathname and query without `new URL()`:
 * the suite always sends origin-form paths, so a plain split is exact.
 * Anything unusual (absolute-form, fragments, dot segments) falls back
 * to `new URL()` so its replies stay identical.
 */
function parseRequestUrl(raw: string): { pathname: string; query: URLSearchParams } | null {
  if (!raw.startsWith('/')) {
    try {
      const url = new URL(raw, 'http://127.0.0.1');
      return { pathname: url.pathname, query: url.searchParams };
    } catch {
      return null;
    }
  }
  if (raw.includes('#') || raw.includes('//') || raw.includes('/./') || raw.includes('/../')) {
    try {
      const url = new URL(raw, 'http://127.0.0.1');
      return { pathname: url.pathname, query: url.searchParams };
    } catch {
      return null;
    }
  }
  const q = raw.indexOf('?');
  if (q < 0) return { pathname: raw, query: EMPTY_PARAMS };
  return { pathname: raw.slice(0, q), query: new URLSearchParams(raw.slice(q + 1)) };
}

/** True when the request cannot carry a body, so no stream read is needed. */
function hasNoBody(request: IncomingMessage): boolean {
  if (request.headers['transfer-encoding'] !== undefined) return false;
  const length = request.headers['content-length'];
  if (length !== undefined) return length === '0';
  // No length and no chunking: only GET/HEAD are bodyless by construction.
  return request.method === 'GET' || request.method === 'HEAD';
}

/**
 * The request body when it has already arrived whole in the socket
 * buffer (small POSTs on loopback usually arrive with their headers):
 * read it synchronously instead of waiting for data/end events. Null
 * when the body is not fully buffered yet: the caller takes the async
 * path, having consumed nothing.
 */
function tryReadBodySync(request: IncomingMessage): Buffer | null {
  const length = request.headers['content-length'];
  if (length === undefined || request.headers['transfer-encoding'] !== undefined) return null;
  const size = Number(length);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BODY_BYTES) return null;
  if (request.readableLength < size) return null;
  const chunk = request.read(size);
  if (chunk === null) return null;
  if (chunk.length !== size) {
    request.unshift(chunk);
    return null;
  }
  return chunk as Buffer;
}

/** Split a pathname into decoded segments; null when a segment does not decode. */
function decodeSegments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  // The common case: no escape to decode, so the split parts are final.
  if (!pathname.includes('%')) return parts;
  const segments: string[] = [];
  for (const part of parts) {
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return segments;
}

/** The bearer token on a request, or null when the header is absent or malformed. */
function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

/** Build the server. It does not listen: the caller picks the port. */
export function createApp(options: AppOptions): { server: Server; forge: Forge } {
  const { forge, token } = options;

  /**
   * Route one request whose body is already in hand. Synchronous: every
   * layer below is sync, so a bodyless request never waits on a promise.
   */
  const dispatch = (
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    pathname: string,
    query: URLSearchParams,
    segments: string[],
    body: Buffer,
  ): void => {
    try {
      // REST v3 under /api/v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const restRequest: RestRequest = {
          method,
          segments: segments.slice(2),
          pathname,
          query,
          host: request.headers.host ?? '127.0.0.1',
          rawBody: body,
        };
        const result = handleRest(forge, restRequest);
        if (result.body !== undefined) {
          send(response, result.status, 'application/json', result.body, result.headers);
        } else {
          sendJson(response, result.status, result.json, result.headers);
        }
        return;
      }

      // GraphQL at /api/graphql.
      if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
        if (method !== 'POST') {
          sendJson(response, 404, { message: 'Not Found' });
          return;
        }
        const result = handleGraphQL(forge, body);
        sendJson(response, result.status, result.json);
        return;
      }

      // MCP at /mcp.
      if (segments[0] === 'mcp' && segments.length === 1) {
        if (method !== 'POST') {
          sendJson(response, 405, { message: 'Method Not Allowed' });
          return;
        }
        const result = handleMcp(forge, body);
        if (result.json === null) {
          send(response, result.status, 'application/json', Buffer.alloc(0));
        } else {
          sendJson(response, result.status, result.json);
        }
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/<service>.
      if (segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')) {
        const owner = segments[0] as string;
        const repoName = (segments[1] as string).slice(0, -'.git'.length);
        const repo = forge.getRepo(owner, repoName);
        if (repo === undefined) {
          sendJson(response, 404, { message: 'Not Found' });
          return;
        }
        const tail = segments.slice(2);
        if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
          const service = query.get('service');
          if (service === null) {
            sendJson(response, 400, { message: 'service parameter is required' });
            return;
          }
          const gitProtocolHeader = request.headers['git-protocol'];
          const gitProtocol = Array.isArray(gitProtocolHeader) ? gitProtocolHeader.join(',') : gitProtocolHeader;
          const result = handleInfoRefs(forge, repo, service, gitProtocol);
          send(response, result.status, result.contentType, result.body, { 'cache-control': 'no-cache' });
          return;
        }
        if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
          const result = handleUploadPack(forge, repo, body);
          send(response, result.status, result.contentType, result.body);
          return;
        }
        if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
          const result = handleReceivePack(forge, repo, body);
          send(response, result.status, result.contentType, result.body);
          return;
        }
        sendJson(response, 404, { message: 'Not Found' });
        return;
      }

      sendJson(response, 404, { message: 'Not Found' });
    } catch (err) {
      if (err instanceof GitHttpError) {
        if (!response.headersSent) sendJson(response, err.status, { message: err.message });
        return;
      }
      console.error(`[forge] request failed: ${(err as Error).message}`);
      if (!response.headersSent) sendJson(response, 500, { message: 'Internal Server Error' });
    }
  };

  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const parsed = parseRequestUrl(request.url ?? '/');
    if (parsed === null) {
      sendJson(response, 400, { message: 'request URL did not parse' });
      return;
    }
    let pathname = parsed.pathname;
    const query = parsed.query;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    // The health check answers without authentication.
    if (pathname === '/healthz' && method === 'GET') {
      send(response, 200, 'text/plain', Buffer.from('ok', 'utf8'));
      return;
    }

    // Everything else needs the trial's bearer token.
    if (token !== '' && bearerToken(request) !== token) {
      sendJson(response, 401, { message: 'Bad credentials' });
      return;
    }

    const segments = decodeSegments(pathname);
    if (segments === null) {
      sendJson(response, 400, { message: 'path did not decode' });
      return;
    }

    // A request that cannot carry a body is dispatched at once.
    if (hasNoBody(request)) {
      dispatch(request, response, method, pathname, query, segments, EMPTY_BODY);
      return;
    }

    // A small body that already arrived whole is read synchronously.
    const buffered = tryReadBodySync(request);
    if (buffered !== null) {
      dispatch(request, response, method, pathname, query, segments, buffered);
      return;
    }

    void (async () => {
      const body = await readBody(request);
      if (body === null) {
        sendJson(response, 413, { message: 'request body is too large' });
        return;
      }
      dispatch(request, response, method, pathname, query, segments, body);
    })();
  });

  // Small request/response pairs on a warm keep-alive socket: never let
  // Nagle delay a reply, and never drop an idle pooled socket mid-trial.
  server.keepAliveTimeout = 30000;
  server.on('connection', (socket) => socket.setNoDelay(true));

  return { server, forge };
}
