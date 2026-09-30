/**
 * The safe telemetry of a run: what each agent selected, the bounded
 * amount, its declared rationale, runtime and Mandate status, and the
 * latencies — plus the Room's generations and outcome and the
 * policy-stress attempts. Exactly what the Live AI Lab records about a
 * model; never a prompt, a raw answer, a reasoning trace or a key.
 */

import type { PolicyStressResult } from '../policy-stress/runner.ts';
import type { RunResult } from '../session.ts';
import { usdcText, type Role } from '../types.ts';

export interface AgentSummary {
  readonly role: Role;
  readonly state: string;
  readonly candidateId: string | null;
  readonly requested: string | null;
  readonly rationale: string | null;
  readonly reasons: readonly string[];
  readonly error: string | null;
  readonly providerLatencyMs: number | null;
  readonly timeToFirstResponseMs: number | null;
  readonly validationLatencyMs: number | null;
  readonly signingLatencyMs: number | null;
  readonly mandateLatencyMs: number | null;
  readonly endToEndLatencyMs: number | null;
  readonly injectedLatencyMs: number;
}

export interface RunSummary {
  readonly status: string;
  readonly mandateVersion: number | null;
  readonly epochs: number;
  readonly agents: readonly AgentSummary[];
  readonly room: {
    readonly status: string;
    readonly generations: number;
    readonly durationMs: number;
    readonly replies: readonly { readonly generation: number; readonly role: Role; readonly status: string; readonly action: string | null; readonly providerLatencyMs: number | null }[];
    readonly agreed: readonly { readonly role: Role; readonly amount: string }[];
  } | null;
  readonly final: readonly { readonly role: Role; readonly outcome: string; readonly requested: string; readonly reasons: readonly string[] }[];
  readonly reserved: string;
  readonly receipts: readonly string[];
  readonly transactions: number;
}

export function summarizeRun(r: RunResult): RunSummary {
  return {
    status: r.status,
    mandateVersion: r.version,
    epochs: r.epochs,
    agents: r.discovery.map((o) => ({
      role: o.role,
      state: o.state,
      candidateId: o.decision?.candidateId ?? null,
      requested: o.decision?.requestedAtoms === null || o.decision === null ? null : usdcText(o.decision.requestedAtoms),
      rationale: o.decision?.rationale ?? null,
      reasons: o.screening === null ? [] : o.screening.reasons.map((x) => (x.subject === '' ? x.code : `${x.code}:${x.subject}`)),
      error: o.error,
      providerLatencyMs: o.timing?.providerLatencyMs ?? null,
      timeToFirstResponseMs: o.timing?.timeToFirstResponseMs ?? null,
      validationLatencyMs: o.timing?.validationLatencyMs ?? null,
      signingLatencyMs: o.timing?.signingLatencyMs ?? null,
      mandateLatencyMs: o.timing?.mandateLatencyMs ?? null,
      endToEndLatencyMs: o.timing?.endToEndLatencyMs ?? null,
      injectedLatencyMs: o.timing?.injectedLatencyMs ?? 0,
    })),
    room:
      r.room === null
        ? null
        : {
            status: r.room.status,
            generations: r.room.stats.generations,
            durationMs: r.room.stats.durationMs,
            replies: r.room.stats.replies.map((x) => ({ generation: x.generation, role: x.role, status: x.status, action: x.action, providerLatencyMs: x.providerLatencyMs })),
            agreed: [...r.room.requests].map(([role, atoms]) => ({ role, amount: usdcText(atoms) })),
          },
    final: [...r.final, ...r.refreshed].map((p) => ({ role: p.role, outcome: p.outcome, requested: usdcText(p.requested), reasons: p.reasons })),
    reserved: usdcText(r.reservedAtoms),
    receipts: r.receipts,
    transactions: r.transactions,
  };
}

export function summarizePolicyStress(r: PolicyStressResult): { readonly endedBy: string; readonly attempts: readonly { readonly attempt: number; readonly caseId: string; readonly rationale: string; readonly outcome: string; readonly screening: string | null; readonly reasons: readonly string[]; readonly providerLatencyMs: number | null }[] } {
  return {
    endedBy: r.endedBy,
    attempts: r.attempts.map((a) => ({ attempt: a.attempt, caseId: a.caseId, rationale: a.rationale, outcome: a.outcome, screening: a.screening?.verdict ?? null, reasons: a.reasons, providerLatencyMs: a.providerLatencyMs })),
  };
}
