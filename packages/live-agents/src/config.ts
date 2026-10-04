/**
 * Runtime configuration — the only module that reads the environment.
 *
 * `OPENAI_API_KEY` is read here and handed straight to `OpenAIProvider`,
 * which keeps it in a private field. It is never printed: `describeConfig`
 * reports only whether it is present.
 */

import { DEFAULT_OPENAI_MODEL } from './runtime/openai-provider.ts';

export interface LiveConfig {
  readonly openaiApiKey: string | null;
  readonly openaiModel: string;
  readonly agentTimeoutMs: number;
  readonly roomRoundTimeoutMs: number;
  readonly port: number;
  readonly host: '127.0.0.1' | '0.0.0.0';
  readonly publicDemo: boolean;
  readonly allowedOrigins: readonly string[];
  /** Where durable local sessions are kept. `agents:serve` ignores this in public-demo mode. */
  readonly stateDir: string;
}

export const DEFAULTS = { agentTimeoutMs: 30_000, roomRoundTimeoutMs: 30_000, port: 8787 } as const;

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
}

function exactHttpsOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '' || raw.includes('*')) return null;
  const value = raw.trim();
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

export function readConfig(env: { readonly [k: string]: string | undefined } = process.env): LiveConfig {
  const key = env['OPENAI_API_KEY'];
  const model = env['OPENAI_MODEL'];
  const publicDemo = env['MANDATE_PUBLIC_DEMO'] === '1';
  const publicOrigin = exactHttpsOrigin(env['MANDATE_ALLOWED_ORIGIN']);
  if (publicDemo && publicOrigin === null) throw new Error('MANDATE_ALLOWED_ORIGIN must be one exact HTTPS origin in public-demo mode.');
  const localPort = positiveInt(env['LIVE_AGENTS_PORT'], DEFAULTS.port, 65_535);
  const localOrigins = (env['LIVE_ALLOWED_ORIGINS'] ?? 'http://localhost:3000,http://127.0.0.1:3000').split(',').map((s) => s.trim()).filter((s) => s !== '');
  return {
    openaiApiKey: key === undefined || key.trim() === '' ? null : key.trim(),
    openaiModel: model === undefined || model.trim() === '' ? DEFAULT_OPENAI_MODEL : model.trim(),
    agentTimeoutMs: positiveInt(env['AGENT_TIMEOUT_MS'], DEFAULTS.agentTimeoutMs, 600_000),
    roomRoundTimeoutMs: positiveInt(env['ROOM_ROUND_TIMEOUT_MS'], DEFAULTS.roomRoundTimeoutMs, 600_000),
    port: publicDemo ? positiveInt(env['PORT'], localPort, 65_535) : localPort,
    host: publicDemo ? '0.0.0.0' : '127.0.0.1',
    publicDemo,
    allowedOrigins: publicDemo ? [publicOrigin as string] : localOrigins,
    stateDir: env['LIVE_STATE_DIR'] === undefined || env['LIVE_STATE_DIR'].trim() === '' ? '.live' : env['LIVE_STATE_DIR'].trim(),
  };
}

/** Safe to print. */
export function describeConfig(c: LiveConfig): string {
  return `mode ${c.publicDemo ? 'public-demo' : 'local'} · OPENAI_API_KEY ${c.openaiApiKey === null ? 'absent' : 'present'} · OPENAI_MODEL ${c.openaiModel} · AGENT_TIMEOUT_MS ${c.agentTimeoutMs} · ROOM_ROUND_TIMEOUT_MS ${c.roomRoundTimeoutMs}`;
}
