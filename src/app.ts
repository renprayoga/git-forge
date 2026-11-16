// The forge's HTTP server: health probe, GitHub REST v3, GraphQL v4, MCP and
// git smart HTTP, all on one port. Written from scratch for this entry.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { advertisement, handleFetchV0, handleFetchV2, handleLsRefs, handleReceivePack, parsePktLines, pktLinesOf } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { errResp, notFound, type ReqCtx, type Resp } from './http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token the env hands out; unset locally means "any non-empty token". */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = body.endsWith('\n') ? body : `${body}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const requestId = store.newRequestId();

      // The env's boot probe: no auth, 200 {"ok": true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, JSON.stringify({ ok: true }));
        return;
      }

      // Every other call carries Authorization: Bearer $MAKEFUN_SHOP_TOKEN.
      if (!authed(req)) {
        sendJson(res, 401, JSON.stringify({ message: 'Requires authentication' }), { 'x-github-request-id': requestId });
        return;
      }
      const jsonHeaders = { 'x-github-request-id': requestId };

      // ---- git smart HTTP: /<owner>/<repo>.git/... ----
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch) {
        const owner = decodeSegment(gitMatch[1]!);
        const repoName = decodeSegment(gitMatch[2]!);
        const suffix = gitMatch[3] ?? '';
        if (store.viewerLogin === null) store.bindViewer(owner);
        const repo = owner === store.viewerLogin ? store.getRepo(owner, repoName) : null;
        if (!repo) {
          sendJson(res, 404, JSON.stringify({ message: 'Not Found' }), jsonHeaders);
          return;
        }
        const body = await readBody(req);
        if (method === 'GET' && suffix === '/info/refs') {
          const service = queryOf(req).get('service');
          if (service === 'git-upload-pack' || service === 'git-receive-pack') {
            const wantV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
            const adv = advertisement(repo, service, wantV2);
            sendBuffer(res, 200, adv, `application/x-${service}-advertisement`);
            return;
          }
          sendJson(res, 404, JSON.stringify({ message: 'Not Found' }), jsonHeaders);
          return;
        }
        if (method === 'POST' && suffix === '/git-upload-pack') {
          const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          if (wantV2) {
            const packets = parsePktLines(body);
            const first = pktLinesOf(packets)[0]?.trim() ?? '';
            let out: Buffer;
            if (first === 'command=ls-refs') out = handleLsRefs(repo, packets);
            else if (first === 'command=fetch') out = handleFetchV2(repo, packets);
            else {
              sendJson(res, 400, JSON.stringify({ message: 'unknown command' }), jsonHeaders);
              return;
            }
            sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
            return;
          }
          const out = handleFetchV0(repo, parsePktLines(body));
          sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
          return;
        }
        if (method === 'POST' && suffix === '/git-receive-pack') {
          const { status, body: out } = handleReceivePack(store, repo, body);
          sendBuffer(res, status, out, 'application/x-git-receive-pack-result');
          return;
        }
        sendJson(res, 404, JSON.stringify({ message: 'Not Found' }), jsonHeaders);
        return;
      }

      // ---- API surfaces ----
      const segments = path.split('/').filter((s) => s !== '');
      const isApiV3 = segments[0] === 'api' && segments[1] === 'v3';
      if (isApiV3) {
        const restSegments = segments.slice(2);
        // GET /api/v3/ root is handled by handleRest (segments []).
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        let parsed: unknown;
        let bodyError = false;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            bodyError = true;
          }
        }
        const ctx: ReqCtx = {
          store,
          method,
          path,
          segments: restSegments,
          query: queryOf(req),
          bodyText: body.toString('utf8'),
          body: parsed,
          bodyError,
          authed: true,
          origin: `http://${req.headers.host ?? "127.0.0.1"}`,
          requestId,
        };
        const answer: Resp = handleRest(ctx) ?? notFound();
        sendJson(res, answer.status, answer.body, { ...jsonHeaders, ...(answer.headers ?? {}) });
        return;
      }

      if (method === 'POST' && path === '/api/graphql') {
        const body = await readBody(req);
        let parsed: unknown;
        let bodyError = false;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            bodyError = true;
          }
        }
        const ctx: ReqCtx = {
          store,
          method,
          path,
          segments: [],
          query: queryOf(req),
          bodyText: body.toString('utf8'),
          body: parsed,
          bodyError,
          authed: true,
          origin: `http://${req.headers.host ?? "127.0.0.1"}`,
          requestId,
        };
        const answer = handleGraphQL(ctx);
        sendJson(res, answer.status, answer.body, { ...jsonHeaders, ...(answer.headers ?? {}) });
        return;
      }

      if (method === 'POST' && path === '/mcp') {
        const body = await readBody(req);
        let parsed: unknown;
        let bodyError = false;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            bodyError = true;
          }
        }
        const ctx: ReqCtx = {
          store,
          method,
          path,
          segments: [],
          query: queryOf(req),
          bodyText: body.toString('utf8'),
          body: parsed,
          bodyError,
          authed: true,
          origin: `http://${req.headers.host ?? "127.0.0.1"}`,
          requestId,
        };
        const answer = handleMcp(ctx);
        if (answer.status === 202) {
          res.writeHead(202, { ...jsonHeaders });
          res.end();
          return;
        }
        sendJson(res, answer.status, answer.body, { ...jsonHeaders, ...(answer.headers ?? {}) });
        return;
      }

      // ---- anything else: GitHub's JSON 404 ----
      const fallback = errResp(404, 'Not Found');
      sendJson(res, fallback.status, fallback.body, jsonHeaders);
    })().catch((err: unknown) => {
      try {
        if (!res.headersSent) {
          sendJson(res, 500, JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' }), { 'x-github-request-id': store.newRequestId() });
        } else {
          res.end();
        }
      } catch {
        // The connection is already gone; nothing more to do.
      }
    });
  });
}
