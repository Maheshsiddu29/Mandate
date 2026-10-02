/**
 * Browser client for the local Live AI Lab server (`npm run agents:serve`).
 *
 * The browser never talks to a model provider and never holds a key. It
 * talks only to the loopback server, which calls the provider server-side
 * and streams MANDATE_LIVE_AI.V1 events. A configured server URL that is
 * not loopback is refused.
 */

export const DEFAULT_LIVE_SERVER = "http://127.0.0.1:8787";

/** The local server's base URL, or null when the configured one is not a loopback http URL. */
export function liveServerUrl(configured: string | undefined): string | null {
  const raw = configured === undefined || configured.trim() === "" ? DEFAULT_LIVE_SERVER : configured.trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") return null;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonRecord = { [key: string]: Json };

export interface LiveEvent {
  schema: "MANDATE_LIVE_AI.V1";
  sessionId: string;
  sequence: number;
  kind: string;
  at: string;
  elapsedMs: number;
  protocolTime: string;
  mandateVersion: number | null;
  agent: string | null;
  roomId: string | null;
  generation: number | null;
  data: JsonRecord;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  body: JsonRecord;
}

export async function api(base: string, method: "GET" | "POST", path: string, body?: JsonRecord): Promise<ApiResult> {
  const init: RequestInit = { method, headers: body === undefined ? {} : { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  try {
    const res = await fetch(`${base}/api/live${path}`, init);
    const parsed: unknown = await res.json().catch(() => ({}));
    const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonRecord) : {};
    return { ok: res.ok, status: res.status, body: record };
  } catch {
    return { ok: false, status: 0, body: { error: "SERVER_UNREACHABLE", message: "The local Live AI Lab server is not reachable. Start it with npm run agents:serve." } };
  }
}

export function isLiveEvent(x: unknown): x is LiveEvent {
  if (typeof x !== "object" || x === null) return false;
  const e = x as { schema?: unknown; sequence?: unknown; kind?: unknown; data?: unknown };
  return e.schema === "MANDATE_LIVE_AI.V1" && typeof e.sequence === "number" && typeof e.kind === "string" && typeof e.data === "object" && e.data !== null;
}

/** Subscribe to a session's events. Returns a function that closes the stream. */
export function streamEvents(base: string, sessionId: string, after: number, onEvent: (e: LiveEvent) => void, onError: () => void): () => void {
  const source = new EventSource(`${base}/api/live/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`);
  source.addEventListener("live", (m) => {
    try {
      const parsed: unknown = JSON.parse((m as MessageEvent<string>).data);
      if (isLiveEvent(parsed)) onEvent(parsed);
    } catch {
      // A malformed frame is dropped; the stream itself continues.
    }
  });
  source.onerror = onError;
  return () => source.close();
}

// --- Small readers over untyped event data ---------------------------------------------------

export const str = (v: Json | undefined): string => (v === undefined || v === null ? "—" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));
export const rec = (v: Json | undefined): JsonRecord => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
export const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
export const amount = (v: Json | undefined): string => {
  const r = rec(v);
  return typeof r.amount === "string" ? `${r.amount} USDC` : "—";
};
export const ms = (v: Json | undefined): string => (typeof v === "number" ? `${v} ms` : "—");
/**
 * A reason code without its subject: `RECIPIENT_NOT_ALLOWED:recipients:0x…` → `RECIPIENT_NOT_ALLOWED`.
 * A registry or ledger code keeps the component that decided, which is part of the code itself:
 * `REGISTRY:ISSUER_NOT_ALLOWED:eip155:46630/erc20:0x…` → `REGISTRY:ISSUER_NOT_ALLOWED`, never bare `REGISTRY`.
 */
export const code = (v: Json): string => {
  const parts = str(v).split(":");
  const head = parts[0] ?? "";
  return (head === "REGISTRY" || head === "LEDGER") && parts.length > 1 && parts[1] !== "" ? `${head}:${parts[1]}` : head;
};
/**
 * An event's typed-resource conflicts, one per resource and never summed, e.g.
 * `derivative-notional 600 USDC > 400 USDC (reduce 200 USDC)`, or once the Room
 * has proposed, `derivative-notional 600 USDC → 400 USDC ≤ 400 USDC SATISFIED`.
 */
export const conflicts = (v: Json | undefined): string =>
  arr(v)
    .map(rec)
    .map((c) => (c.status === undefined ? `${str(c.resource)} ${amount(c.demand)} > ${amount(c.authority)} (reduce ${amount(c.requiredReduction)})` : `${str(c.resource)} ${amount(c.demand)} → ${amount(c.demandAfter)} ${c.status === "SATISFIED" ? "≤" : ">"} ${amount(c.authority)} ${str(c.status)}`))
    .join("; ");
