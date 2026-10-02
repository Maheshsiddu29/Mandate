/**
 * Latency chaos. **Development only; artificial; always labelled.**
 *
 * Wraps a provider and, per call, adds a delay before it (0, 250, 1000, 3000
 * or 8000 ms), never answers (a forced timeout), or fails. The delay is
 * reported as `injectedLatencyMs` on the response and subtracted from
 * `providerLatencyMs` by the runtime, so artificial and real latency are
 * never mixed. Plans are deterministic: the same spec gives the same effect
 * for the same call.
 */

import type { Clock } from './clock.ts';
import { ProviderError } from './errors.ts';
import { callProvider, type AgentModelProvider, type ProviderKind, type CallOptions, type DecisionRequest, type DraftRequest, type ModelRequest, type ModelResponse, type NegotiationRequest, type OpportunityRequest, type PolicyStressRequest } from './provider.ts';
import { isRole, type Role } from '../types.ts';

export const CHAOS_DELAYS_MS = [0, 250, 1000, 3000, 8000] as const;

export type ChaosEffect = { readonly kind: 'DELAY'; readonly ms: number } | { readonly kind: 'TIMEOUT' } | { readonly kind: 'FAILURE' };

/** Where a rule applies: the discovery decision, the Room, or both; for one role or every role. */
export interface ChaosRule {
  readonly phase: 'decide' | 'room' | 'any';
  readonly role: Role | '*';
  readonly effect: ChaosEffect;
}

export type ChaosPlan = readonly ChaosRule[];

function roleOf(r: ModelRequest): Role | null {
  return r.kind === 'DECISION' || r.kind === 'NEGOTIATION' || r.kind === 'OPPORTUNITY' ? r.role : null;
}

export function effectFor(plan: ChaosPlan, r: ModelRequest): ChaosEffect {
  // An opportunity card is a decision for chaos purposes: the agent's own analysis, before any Room reply.
  const phase = r.kind === 'DECISION' || r.kind === 'OPPORTUNITY' ? 'decide' : r.kind === 'NEGOTIATION' ? 'room' : null;
  const role = roleOf(r);
  if (phase === null || role === null) return { kind: 'DELAY', ms: 0 };
  const rule = plan.find((x) => (x.phase === 'any' || x.phase === phase) && (x.role === '*' || x.role === role));
  return rule?.effect ?? { kind: 'DELAY', ms: 0 };
}

/**
 * `"perps:3000,stock:timeout,room.nft:failure,*:250"`: `[phase.]role:effect`,
 * first match wins. Delays are restricted to `CHAOS_DELAYS_MS`.
 */
export function parseChaosSpec(spec: string): ChaosPlan | { readonly error: string } {
  const rules: ChaosRule[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const m = /^(?:(decide|room)\.)?([a-z*]+):(timeout|failure|\d+)$/.exec(part);
    if (m === null) return { error: `cannot read chaos rule "${part}"` };
    const role = m[2] as string;
    if (role !== '*' && !isRole(role)) return { error: `unknown role "${role}"` };
    const e = m[3] as string;
    let effect: ChaosEffect;
    if (e === 'timeout') effect = { kind: 'TIMEOUT' };
    else if (e === 'failure') effect = { kind: 'FAILURE' };
    else {
      const ms = Number(e);
      if (!(CHAOS_DELAYS_MS as readonly number[]).includes(ms)) return { error: `delay ${ms} ms is not one of ${CHAOS_DELAYS_MS.join(', ')}` };
      effect = { kind: 'DELAY', ms };
    }
    rules.push({ phase: (m[1] as 'decide' | 'room' | undefined) ?? 'any', role: role as Role | '*', effect });
  }
  return rules;
}

export class LatencyChaosProvider implements AgentModelProvider {
  readonly name: string;
  readonly model: string;
  readonly kind: ProviderKind;
  readonly #inner: AgentModelProvider;
  readonly #plan: ChaosPlan;
  readonly #clock: Clock;

  constructor(inner: AgentModelProvider, plan: ChaosPlan, clock: Clock) {
    this.#inner = inner;
    this.#plan = plan;
    this.#clock = clock;
    this.name = `${inner.name}+chaos`;
    this.model = inner.model;
    this.kind = inner.kind;
  }

  async #run(r: ModelRequest, o: CallOptions): Promise<ModelResponse> {
    const effect = effectFor(this.#plan, r);
    if (effect.kind === 'FAILURE') throw new ProviderError('INJECTED_FAILURE', 'artificial provider failure (latency chaos)');
    if (effect.kind === 'TIMEOUT') {
      // Never answers: waits for the caller's own timeout to abort it.
      await new Promise<never>((_, reject) => o.signal.addEventListener('abort', () => reject(new ProviderError('INJECTED_FAILURE', 'artificial hang aborted')), { once: true }));
    }
    const ms = effect.kind === 'DELAY' ? effect.ms : 0;
    if (ms > 0) await this.#clock.sleep(ms, o.signal);
    const response = await callProvider(this.#inner, r, o);
    return { ...response, injectedLatencyMs: (response.injectedLatencyMs ?? 0) + ms };
  }

  decide(r: DecisionRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#run(r, o);
  }
  negotiate(r: NegotiationRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#run(r, o);
  }
  interpretMandateDraft(r: DraftRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#run(r, o);
  }
  selectPolicyCase(r: PolicyStressRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#run(r, o);
  }
  assessOpportunity(r: OpportunityRequest, o: CallOptions): Promise<ModelResponse> {
    return this.#run(r, o);
  }
}
