/**
 * A scripted live session: decisions by role, negotiation answers by role
 * and generation, protocol time under the test's control.
 */

import type { EligibilityFilter } from '../../src/agents/eligibility.ts';
import { presetDraft, type MandateDraft } from '../../src/authoring/draft-types.ts';
import type { NegotiationRequest } from '../../src/runtime/provider.ts';
import { LiveSession } from '../../src/session.ts';
import type { Role } from '../../src/types.ts';
import type { LiveEvent, LiveEventKind } from '../../src/telemetry/events.ts';
import { ScriptedProvider, json, type Scripted } from './providers.ts';
import { TestTime } from './world.ts';

export const USDC = (whole: number): string => (BigInt(whole) * 1_000_000n).toString();
export const propose = (candidateId: string, whole: number): string => json({ action: 'PROPOSE', candidateId, requestedAtoms: USDC(whole), rationale: `pick ${candidateId}` });
export const abstain = json({ action: 'ABSTAIN', candidateId: null, requestedAtoms: null, rationale: 'nothing acceptable' });
export const keep = json({ action: 'KEEP', newRequestedAtoms: null, rationale: 'keep' });
export const reduce = (whole: number): string => json({ action: 'REDUCE', newRequestedAtoms: USDC(whole), rationale: `reduce to ${whole}` });
export const release = json({ action: 'RELEASE', newRequestedAtoms: null, rationale: 'withdraw' });

export type Decisions = { readonly [R in Role]?: Scripted };
export type Negotiation = (r: NegotiationRequest) => Scripted;

export interface Scripted_ {
  readonly session: LiveSession;
  readonly time: TestTime;
  readonly provider: ScriptedProvider;
  readonly kinds: () => readonly LiveEventKind[];
  readonly of: (kind: LiveEventKind) => readonly LiveEvent[];
}

export async function scriptedSession(decisions: Decisions | ((role: Role, call: number) => Scripted), negotiation: Negotiation = () => ({ text: keep }), o: { readonly draft?: MandateDraft; readonly agentTimeoutMs?: number; readonly roomRoundTimeoutMs?: number; readonly maxGenerations?: number; readonly eligibility?: EligibilityFilter } = {}): Promise<Scripted_> {
  const time = new TestTime();
  const calls = new Map<Role, number>();
  const provider = new ScriptedProvider({
    decide: (r) => {
      const n = calls.get(r.role) ?? 0;
      calls.set(r.role, n + 1);
      return typeof decisions === 'function' ? decisions(r.role, n) : decisions[r.role] ?? { text: abstain };
    },
    negotiate: (r) => negotiation(r),
  });
  const session = new LiveSession({ provider, sessionId: 'test', agentTimeoutMs: o.agentTimeoutMs ?? 1_000, roomRoundTimeoutMs: o.roomRoundTimeoutMs ?? 1_000, maxGenerations: o.maxGenerations ?? 3, protocolNow: time.read, ...(o.eligibility === undefined ? {} : { eligibility: o.eligibility }) });
  const r = await session.authorize(o.draft ?? presetDraft('balanced'), 'AUTHORIZE MANDATE V1');
  if (!r.ok) throw new Error(`test mandate refused: ${r.code}`);
  return {
    session,
    time,
    provider,
    kinds: () => session.events.events.map((e) => e.kind),
    of: (kind) => session.events.events.filter((e) => e.kind === kind),
  };
}

/** The five reviewed instruments at sizes that together exceed the balanced mandate: 2,500 notional, 600 derivative. */
export const CONFLICTING: Decisions = {
  stock: { text: propose('nvda-note-a', 600) },
  swap: { text: propose('route-a', 300) },
  nft: { text: propose('genesis-11', 300) },
  yield: { text: propose('alpha-usd-vault', 700) },
  perps: { text: propose('btc-long-2x', 600) },
};
