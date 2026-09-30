/**
 * Per-agent latency: when each step happened (wall clock) and how long each
 * took (monotonic). Provider latency is the model call alone; injected
 * latency — artificial, from the development chaos wrapper — is reported
 * separately and never counted as the provider's.
 */

import type { CallTiming } from '../runtime/agent-runtime.ts';

export interface AgentTiming {
  readonly provider: string;
  readonly model: string;
  readonly requestStartedAt: string;
  readonly firstResponseAt: string | null;
  readonly responseCompletedAt: string | null;
  readonly decisionValidatedAt: string | null;
  readonly proposalSignedAt: string | null;
  readonly mandateScreenedAt: string | null;
  readonly providerLatencyMs: number | null;
  readonly timeToFirstResponseMs: number | null;
  readonly validationLatencyMs: number | null;
  readonly signingLatencyMs: number | null;
  readonly mandateLatencyMs: number | null;
  readonly endToEndLatencyMs: number | null;
  readonly injectedLatencyMs: number;
}

export interface Marks {
  readonly signedAt: string | null;
  readonly signedMs: number | null;
  readonly screenedAt: string | null;
  readonly screenedMs: number | null;
  readonly endMs: number;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export function agentTiming(provider: { readonly name: string; readonly model: string }, t: CallTiming, m: Marks): AgentTiming {
  const signFrom = t.validatedMs;
  return {
    provider: provider.name,
    model: provider.model,
    requestStartedAt: t.requestStartedAt,
    firstResponseAt: t.firstResponseAt,
    responseCompletedAt: t.responseCompletedAt,
    decisionValidatedAt: t.decisionValidatedAt,
    proposalSignedAt: m.signedAt,
    mandateScreenedAt: m.screenedAt,
    providerLatencyMs: t.providerLatencyMs,
    timeToFirstResponseMs: t.timeToFirstResponseMs,
    validationLatencyMs: t.validationLatencyMs,
    signingLatencyMs: m.signedMs === null || signFrom === null ? null : round(m.signedMs - signFrom),
    mandateLatencyMs: m.screenedMs === null || m.signedMs === null ? null : round(m.screenedMs - m.signedMs),
    endToEndLatencyMs: round(m.endMs - t.startMs),
    injectedLatencyMs: t.injectedLatencyMs,
  };
}
