/**
 * The HTTP binding of the local Live AI Lab API — the only module in this
 * package that listens on a socket.
 *
 * - Binds to 127.0.0.1 only.
 * - Refuses a request whose Host is not this loopback address (a DNS
 *   rebinding page cannot reach it) and one whose Origin is not on the
 *   allowlist; CORS answers only allowlisted origins.
 * - POST bodies must be `application/json` (which a cross-site form cannot
 *   send without a preflight) and at most 32 KiB.
 * - `GET …/events` is a Server-Sent Events stream of MANDATE_LIVE_AI.V1
 *   events, replayed from `Last-Event-ID` (a reconnect) or `?after=`, then
 *   live — including events another process appended to a durable session.
 *
 * Responses and events come from `LiveLab`, which holds no key; this module
 * adds only headers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JsonValue } from '../runtime/strict-json.ts';
import type { LiveEvent } from '../telemetry/events.ts';
import type { ApiRequest, ApiResponse, LiveLab } from './app.ts';

export const MAX_BODY_BYTES = 32 * 1024;
const HEARTBEAT_MS = 15_000;
const EVENTS = /^\/api\/live\/sessions\/([A-Za-z0-9-]{1,64})\/events$/;

export interface HttpOptions {
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  /**
   * Handled before the lab, after the loopback and origin checks. Return
   * null to fall through. The lab itself never settles; an explicit
   * composition script may attach the V2 settlement spine here.
   */
  readonly before?: (r: ApiRequest) => Promise<ApiResponse | null>;
}

function send(res: ServerResponse, r: ApiResponse, cors: { readonly [k: string]: string }): void {
  const body = JSON.stringify(r.body);
  res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<{ readonly ok: true; readonly value: JsonValue | null } | { readonly ok: false; readonly status: number; readonly error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.byteLength;
      if (size > MAX_BODY_BYTES) {
        done = true;
        resolve({ ok: false, status: 413, error: 'BODY_TOO_LARGE' });
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({ ok: true, value: null });
      try {
        resolve({ ok: true, value: JSON.parse(text) as JsonValue });
      } catch {
        resolve({ ok: false, status: 400, error: 'BODY_NOT_JSON' });
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve({ ok: false, status: 400, error: 'BODY_UNREADABLE' });
      }
    });
  });
}

/** Whether `host` (the Host header) names this server on loopback. */
export function loopbackHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** How often events other processes appended to a durable session are picked up. */
export const SYNC_MS = 400;

export function createLabServer(lab: LiveLab, o: HttpOptions): Server {
  const sweeper = setInterval(() => lab.sweep(), 60_000);
  sweeper.unref();
  const syncer = setInterval(() => lab.syncEvents(), SYNC_MS);
  syncer.unref();
  const server = createServer((req, res) => {
    void (async () => {
      const origin = req.headers.origin;
      const allowed = origin !== undefined && o.allowedOrigins.includes(origin);
      const cors: { readonly [k: string]: string } = allowed ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
      const port = (server.address() as AddressInfo | null)?.port ?? o.port;
      if (!loopbackHost(req.headers.host, port)) return send(res, { status: 421, body: { error: 'HOST_NOT_ALLOWED', message: 'This server answers on 127.0.0.1 only.' } }, {});
      if (origin !== undefined && !allowed) return send(res, { status: 403, body: { error: 'ORIGIN_NOT_ALLOWED', message: 'This origin is not on the allowlist (LIVE_ALLOWED_ORIGINS).' } }, {});
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (req.method === 'OPTIONS') {
        res.writeHead(allowed ? 204 : 403, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
        return res.end();
      }

      const stream = EVENTS.exec(url.pathname);
      if (req.method === 'GET' && stream !== null) {
        // A reconnecting EventSource sends Last-Event-ID: resume after it, so nothing is replayed twice.
        const lastId = req.headers['last-event-id'];
        const after = Number(typeof lastId === 'string' && lastId !== '' ? lastId : (url.searchParams.get('after') ?? '-1'));
        await lab.ensure(stream[1] as string);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff', ...cors });
        const write = (e: LiveEvent) => res.write(`id: ${e.sequence}\nevent: live\ndata: ${JSON.stringify(e)}\n\n`);
        const stop = lab.subscribe(stream[1] as string, Number.isSafeInteger(after) ? after : -1, write);
        if (stop === null) {
          res.write('event: error\ndata: {"error":"SESSION_NOT_FOUND"}\n\n');
          return res.end();
        }
        const beat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
        req.on('close', () => {
          clearInterval(beat);
          stop();
        });
        return undefined;
      }

      let body: JsonValue | null = null;
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, { status: 415, body: { error: 'JSON_REQUIRED', message: 'POST bodies must be application/json.' } }, cors);
        const b = await readBody(req);
        if (!b.ok) return send(res, { status: b.status, body: { error: b.error, message: 'The request body was refused.' } }, cors);
        body = b.value;
      }
      const request: ApiRequest = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body };
      if (o.before !== undefined) {
        const extra = await o.before(request);
        if (extra !== null) return send(res, extra, cors);
      }
      return send(res, await lab.handle(request), cors);
    })();
  });
  server.on('close', () => {
    clearInterval(sweeper);
    clearInterval(syncer);
  });
  return server;
}

/** Listen on 127.0.0.1 only. */
export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
