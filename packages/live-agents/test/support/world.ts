/**
 * A small live world for tests: an authorized mandate version, a protocol
 * clock tests can move, an event log, and discovery dependencies.
 */

import { DEMO_NOW, demoKey } from '@mandate/portfolio/demo';
import { presetDraft, withField, type MandateDraft } from '../../src/authoring/draft-types.ts';
import { MandateVersions, type ActiveMandate } from '../../src/authoring/mandate-versioning.ts';
import type { EligibilityFilter } from '../../src/agents/eligibility.ts';
import type { DiscoveryDeps } from '../../src/discovery.ts';
import { NoopJevAdvisor } from '../../src/jev/noop-advisor.ts';
import { SequenceBook } from '../../src/mandate/proposal-builder.ts';
import { sessionBindings } from '../../src/mandate/portfolio-adapter.ts';
import { LocalPrincipalSigner, createAgentSigners } from '../../src/mandate/signer.ts';
import { realClock } from '../../src/runtime/clock.ts';
import type { AgentModelProvider } from '../../src/runtime/provider.ts';
import { EventLog } from '../../src/telemetry/events.ts';
import { ROLES } from '../../src/types.ts';

export class TestTime {
  now: bigint = DEMO_NOW;
  readonly read = (): bigint => this.now;
}

export interface World {
  readonly time: TestTime;
  readonly versions: MandateVersions;
  readonly events: EventLog;
  readonly deps: (provider: AgentModelProvider, timeoutMs?: number, eligibility?: EligibilityFilter) => DiscoveryDeps;
  readonly active: () => ActiveMandate;
}

export async function world(draft: MandateDraft = presetDraft('balanced')): Promise<World> {
  const time = new TestTime();
  const versions = new MandateVersions({ bindings: sessionBindings(), signer: new LocalPrincipalSigner(), clock: realClock });
  const r = await versions.authorize(draft, 'AUTHORIZE MANDATE V1', time.now);
  if (!r.ok) throw new Error(`test mandate refused: ${r.code} ${JSON.stringify(r.issues)}`);
  const events = new EventLog({ sessionId: 'test', clock: realClock, startMs: realClock.nowMs(), protocolNow: time.read, version: () => versions.active?.version ?? null });
  const signers = createAgentSigners();
  const sequences = new SequenceBook();
  const active = () => {
    const a = versions.active;
    if (a === null) throw new Error('no active mandate');
    return a;
  };
  return {
    time,
    versions,
    events,
    active,
    deps: (provider, timeoutMs = 2_000, eligibility) => ({ provider, jev: new NoopJevAdvisor(), clock: realClock, events, signers, sequences, protocolNow: time.read, timeoutMs, current: () => versions.active, ...(eligibility === undefined ? {} : { eligibility }) }),
  };
}

/**
 * The balanced preset with the perps agent's allocation (600) above the
 * portfolio's derivative limit (400): a 600 perps request is then
 * individually valid and portfolio invalid on derivative notional alone.
 */
export const WIDE_PERPS: MandateDraft = withField(presetDraft('balanced'), 'agents.perps.maxAllocation', '600', 'USER');

/**
 * Adversarial tests only: a filter with a bug, or a client that skipped it —
 * every discovered candidate offered as actionable. Whatever unauthorized
 * action then reaches Mandate, its screening must refuse on its own.
 */
export const everyCandidate: EligibilityFilter = (_active, _role, candidates) => ({ discovered: candidates, actionable: candidates, excluded: [] });

/** Every demonstration private key, to prove none of them ever leaves the signer. */
export const ALL_KEYS: readonly string[] = [...ROLES, 'principal'].map((r) => demoKey(r).replace(/^0x/, ''));

export function containsKey(text: string): boolean {
  const lower = text.toLowerCase();
  return ALL_KEYS.some((k) => lower.includes(k.toLowerCase()));
}
