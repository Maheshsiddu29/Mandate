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
  readonly allowedOrigins: readonly string[];
}

export const DEFAULTS = { agentTimeoutMs: 30_000, roomRoundTimeoutMs: 30_000, port: 8787 } as const;

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
}

export function readConfig(env: { readonly [k: string]: string | undefined } = process.env): LiveConfig {
  const key = env['OPENAI_API_KEY'];
  const model = env['OPENAI_MODEL'];
  return {
    openaiApiKey: key === undefined || key.trim() === '' ? null : key.trim(),
    openaiModel: model === undefined || model.trim() === '' ? DEFAULT_OPENAI_MODEL : model.trim(),
    agentTimeoutMs: positiveInt(env['AGENT_TIMEOUT_MS'], DEFAULTS.agentTimeoutMs, 600_000),
    roomRoundTimeoutMs: positiveInt(env['ROOM_ROUND_TIMEOUT_MS'], DEFAULTS.roomRoundTimeoutMs, 600_000),
    port: positiveInt(env['LIVE_AGENTS_PORT'], DEFAULTS.port, 65_535),
    allowedOrigins: (env['LIVE_ALLOWED_ORIGINS'] ?? 'http://localhost:3000,http://127.0.0.1:3000').split(',').map((s) => s.trim()).filter((s) => s !== ''),
  };
}

/** Safe to print. */
export function describeConfig(c: LiveConfig): string {
  return `OPENAI_API_KEY ${c.openaiApiKey === null ? 'absent' : 'present'} · OPENAI_MODEL ${c.openaiModel} · AGENT_TIMEOUT_MS ${c.agentTimeoutMs} · ROOM_ROUND_TIMEOUT_MS ${c.roomRoundTimeoutMs}`;
}
