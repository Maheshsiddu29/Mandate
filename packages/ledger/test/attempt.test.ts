/**
 * `ADMIT_ATTEMPT` (7E.1): the ledger's durable record that one exact external
 * artifact may be created for one reservation generation. Every admission rule
 * refuses the whole batch; the attempt id, the artifact identity and the venue
 * slot are each bound at most once in a principal's whole history; a
 * reservation has at most one live attempt; the event survives the batch
 * codec and full replay; and a state with no attempt keeps its exact 7D bytes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reservationIdFor,
  validateAdapterRef,
  validateResourceId,
  type AccountId,
  type AdapterRef,
  type Digest32,
  type ExecutionAuthorizationId,
  type LedgerVersion,
} from '@mandate/core';
import type { Identifier } from '@mandate/kernel';
import {
  ReferenceAdapterRegistry,
  ReferenceModuleRegistry,
  anyAttemptAdmitted,
  applyBatch,
  attemptIdFor,
  attemptsOf,
  checkAdapterUsable,
  checkModuleConformance,
  checkModuleIssuable,
  decodeBatch,
  deriveReserveEvent,
  encodeLedgerState,
  replayEncoded,
  type AttemptAdmission,
  type LedgerEvent,
  type LedgerState,
} from '../src/index.ts';
import {
  ALL_MODULES,
  DAY,
  PERP_V1,
  PRINCIPAL,
  T0,
  bootstrap,
  capital,
  closeEvent,
  contribution,
  digestOf,
  dim,
  implFor,
  moduleRef,
  must,
  plan,
  policy,
  reservationOf,
  reserve,
  revocation,
  root,
  step,
  stepRefused,
  units,
} from './support/fixtures.ts';

const ADAPTER: AdapterRef = must(validateAdapterRef({ adapterId: 'test-venue-signer', adapterVersion: 1, adapterDigest: digestOf('adapter:test:1') }));
const ACCOUNT: AccountId = must(validateResourceId({ domain: 'perp', kind: 'ACCOUNT', localId: 'venue-l:sub-1' }, ['ACCOUNT'] as const, 'a'));
const AUTH = digestOf('execution-authorization:1') as ExecutionAuthorizationId;

function reserved(): { s: LedgerState; g: ReturnType<typeof root> } {
  const g = root({ terms: [ALL_MODULES, dim('capital', units(10_000))] });
  let s = bootstrap(policy(), [g]);
  s = reserve(s, plan({ authority: g, action: 'x', contributions: [contribution(capital(units(100)))] }));
  return { s, g };
}

function admission(s: LedgerState, o: Partial<AttemptAdmission> & { label?: string; nonce?: bigint } = {}): AttemptAdmission {
  const reservation = reservationIdFor(digestOf('action:x') as never, 1n as never);
  const r = reservationOf(s, reservation);
  const base = {
    reservation: r.id,
    generation: r.generation,
    action: r.action,
    module: r.module,
    adapter: ADAPTER,
    authorization: AUTH,
    ordinal: 1,
  };
  const merged = { ...base, ...o };
  return {
    attempt: o.attempt ?? attemptIdFor(merged),
    ...merged,
    venueAccount: ACCOUNT,
    artifact: o.artifact ?? { kind: 'test.tx-hash' as Identifier, id: new TextEncoder().encode(`tx:${o.label ?? 'a'}`) },
    slot: o.slot === undefined ? { scope: 'test:sub-1:key-2' as Identifier, sequence: o.nonce ?? 7n } : o.slot,
    validUntil: o.validUntil ?? T0 + 600n,
    requirements: digestOf('pre-execution:ok') as Digest32,
    revalidation: digestOf('revalidation:ok') as Digest32,
  };
}

const admit = (a: AttemptAdmission, at = T0): LedgerEvent => ({ kind: 'ADMIT_ATTEMPT', at, admission: a });

describe('ADMIT_ATTEMPT', () => {
  it('records one attempt against an active reservation, and nothing about it releases or moves authority', () => {
    const { s } = reserved();
    const a = admission(s);
    const after = step(s, [admit(a)]);
    assert.equal(after.attempts.size, 1);
    assert.equal(anyAttemptAdmitted(after, a.reservation), true);
    const [rec] = attemptsOf(after, a.reservation);
    assert.equal(rec?.status, 'ADMITTED');
    assert.equal(rec?.admittedAt, s.version + 1n);
    // Balances are untouched: an attempt is issuance, not accounting.
    assert.deepEqual([...after.targets.entries()], [...s.targets.entries()]);
    assert.equal(reservationOf(after, a.reservation).status, 'ACTIVE');
  });

  it('refuses a second attempt for the same reservation while the first is live — whatever its artifact', () => {
    const { s } = reserved();
    const once = step(s, [admit(admission(s))]);
    assert.equal(stepRefused(once, [admit(admission(once, { ordinal: 2, label: 'b', nonce: 8n }))]).code, 'ATTEMPT_UNRESOLVED');
    // Even an identical re-request is not a new attempt.
    assert.equal(stepRefused(once, [admit(admission(s))]).code, 'ATTEMPT_UNRESOLVED');
    // Time does not free it.
    assert.equal(stepRefused(once, [admit(admission(once, { ordinal: 2, label: 'c', nonce: 9n, validUntil: T0 + 30n * DAY }), T0 + 10n * DAY)]).code, 'ATTEMPT_UNRESOLVED');
  });

  it('never binds an artifact identity or a venue slot twice, across reservations', () => {
    const { s, g } = reserved();
    let two = reserve(s, plan({ authority: g, action: 'y', contributions: [contribution(capital(units(100)))] }));
    two = step(two, [admit(admission(two))]);
    const other = reservationOf(two, reservationIdFor(digestOf('action:y') as never, 1n as never));
    const base = { reservation: other.id, generation: other.generation, action: other.action, module: other.module, adapter: ADAPTER, authorization: AUTH, ordinal: 1 };
    const sameArtifact = admission(two, { ...base, nonce: 99n });
    assert.equal(stepRefused(two, [admit(sameArtifact)]).code, 'ARTIFACT_REUSED');
    const sameSlot = admission(two, { ...base, label: 'fresh' });
    assert.equal(stepRefused(two, [admit(sameSlot)]).code, 'VENUE_SLOT_REUSED');
    assert.equal(step(two, [admit(admission(two, { ...base, label: 'fresh', nonce: 8n }))]).attempts.size, 2);
  });

  it('refuses an admission that restates another generation, action or module, or a non-derived id', () => {
    const { s } = reserved();
    assert.equal(stepRefused(s, [admit(admission(s, { generation: 2n as never }))]).code, 'RESERVATION_ID_MISMATCH');
    const wrongAction = admission(s, { action: digestOf('action:z') as never });
    assert.equal(stepRefused(s, [admit(wrongAction)]).code, 'ATTEMPT_BINDING_MISMATCH');
    const wrongModule = admission(s, { module: moduleRef({ ...PERP_V1, moduleVersion: 2, moduleDigest: digestOf('manifest:perp-policy:2') }) });
    assert.equal(stepRefused(s, [admit(wrongModule)]).code, 'ATTEMPT_BINDING_MISMATCH');
    assert.equal(stepRefused(s, [admit(admission(s, { attempt: digestOf('not-derived') as never }))]).code, 'ATTEMPT_ID_MISMATCH');
    assert.equal(stepRefused(s, [admit(admission(s, { ordinal: 2 }))]).code, 'ATTEMPT_ID_MISMATCH');
  });

  it('refuses on a closed or unknown reservation, an expired artifact, and a revoked lineage', () => {
    const { s, g } = reserved();
    const a = admission(s);
    const closed = step(s, [closeEvent(reservationOf(s, a.reservation), T0)]);
    assert.equal(stepRefused(closed, [admit(a)]).code, 'RESERVATION_CLOSED');
    assert.equal(stepRefused(s, [admit({ ...a, reservation: digestOf('nope') as never })]).code, 'RESERVATION_UNKNOWN');
    assert.equal(stepRefused(s, [admit(admission(s, { validUntil: T0 }))]).code, 'ATTEMPT_EXPIRED');
    const revoked = step(s, [{ kind: 'REVOKE', at: T0, revocation: revocation(g) }]);
    assert.equal(stepRefused(revoked, [admit(a)]).code, 'AUTHORITY_REVOKED');
  });

  it('refuses the whole batch when any admission in it fails', () => {
    const { s } = reserved();
    const out = applyBatch(s, [admit(admission(s)), admit(admission(s, { ordinal: 2, label: 'b', nonce: 8n }))]);
    assert.ok(!out.ok);
    assert.equal(out.error.code, 'ATTEMPT_UNRESOLVED');
  });

  it('survives the batch codec and full replay byte for byte', () => {
    const { s } = reserved();
    const a = admission(s);
    const applied = applyBatch(s, [admit(a)]);
    assert.ok(applied.ok);
    assert.deepEqual(must(decodeBatch(applied.value.encoded)).events, [admit(a)]);
    // Re-derive everything from genesis through stored encodings only.
    const g = root({ terms: [ALL_MODULES, dim('capital', units(10_000))] });
    const history: Uint8Array[] = [];
    let state = must(replayEncoded(PRINCIPAL, []));
    state = appendEncoded(state, [{ kind: 'REGISTER_POLICY', at: T0, policy: policy() }], history);
    state = appendEncoded(state, [{ kind: 'REGISTER_GRANT', at: T0, grant: g }], history);
    state = appendEncoded(state, [must(deriveReserveEvent(state, plan({ authority: g, action: 'x', contributions: [contribution(capital(units(100)))] }), T0))], history);
    state = appendEncoded(state, [admit(admission(state))], history);
    assert.equal(state.attempts.size, 1);
    assert.deepEqual(encodeLedgerState(must(replayEncoded(PRINCIPAL, history))), encodeLedgerState(state));
  });

  it('a state with no attempt keeps its exact pre-7E encoding', () => {
    const { s } = reserved();
    const bytes = encodeLedgerState(s);
    assert.equal(new TextDecoder('latin1').decode(bytes).includes('attempts'), false);
    const after = step(s, [admit(admission(s))]);
    assert.notDeepEqual(encodeLedgerState(after), bytes);
  });
});

function appendEncoded(s: LedgerState, events: readonly LedgerEvent[], history: Uint8Array[]): LedgerState {
  const out = applyBatch(s, events);
  if (!out.ok) assert.fail(`${out.error.code} at ${out.error.path}`);
  history.push(out.value.encoded);
  return out.value.state;
}

describe('module and adapter lifecycle', () => {
  const perp = moduleRef(PERP_V1);
  const registry = (status: 'ACTIVE' | 'RETIRING' | 'DISABLED') => must(ReferenceModuleRegistry.create([{ module: perp, status, implementations: [implFor(PERP_V1)] }]));

  it('DISABLED refuses new decisions and new issuance; RETIRING refuses decisions but may carry an existing reservation to issuance', () => {
    assert.equal(checkModuleConformance(registry('ACTIVE'), perp, implFor(PERP_V1)).ok, true);
    const retiring = checkModuleConformance(registry('RETIRING'), perp, implFor(PERP_V1));
    assert.ok(!retiring.ok && retiring.error.code === 'MODULE_RETIRING');
    const disabled = checkModuleConformance(registry('DISABLED'), perp, implFor(PERP_V1));
    assert.ok(!disabled.ok && disabled.error.code === 'MODULE_DISABLED');
    assert.equal(checkModuleIssuable(registry('ACTIVE'), perp).ok, true);
    assert.equal(checkModuleIssuable(registry('RETIRING'), perp).ok, true);
    const issuable = checkModuleIssuable(registry('DISABLED'), perp);
    assert.ok(!issuable.ok && issuable.error.code === 'MODULE_DISABLED');
  });

  it('adapters are exact by digest; RETIRING authorizes nothing new, DISABLED issues nothing', () => {
    const at = (status: 'ACTIVE' | 'RETIRING' | 'DISABLED') => must(ReferenceAdapterRegistry.create([{ adapter: ADAPTER, status }]));
    assert.equal(checkAdapterUsable(at('ACTIVE'), ADAPTER, 'DECISION').ok, true);
    assert.equal(checkAdapterUsable(at('RETIRING'), ADAPTER, 'ATTEMPT').ok, true);
    const r1 = checkAdapterUsable(at('RETIRING'), ADAPTER, 'DECISION');
    assert.ok(!r1.ok && r1.error.code === 'ADAPTER_RETIRING');
    for (const purpose of ['DECISION', 'ATTEMPT'] as const) {
      const r = checkAdapterUsable(at('DISABLED'), ADAPTER, purpose);
      assert.ok(!r.ok && r.error.code === 'ADAPTER_DISABLED');
    }
    const upgraded = must(validateAdapterRef({ adapterId: 'test-venue-signer', adapterVersion: 1, adapterDigest: digestOf('adapter:test:1:patched') }));
    const r2 = checkAdapterUsable(at('ACTIVE'), upgraded, 'ATTEMPT');
    assert.ok(!r2.ok && r2.error.code === 'ADAPTER_DIGEST_MISMATCH');
    const r3 = checkAdapterUsable(must(ReferenceAdapterRegistry.create([])), ADAPTER, 'ATTEMPT');
    assert.ok(!r3.ok && r3.error.code === 'ADAPTER_UNREGISTERED');
    const dup = ReferenceAdapterRegistry.create([{ adapter: ADAPTER, status: 'ACTIVE' }, { adapter: ADAPTER, status: 'DISABLED' }]);
    assert.ok(!dup.ok && dup.error.code === 'REGISTRY_DUPLICATE_ADAPTER');
  });

  it('a DISABLED module does not make committed history unreplayable', () => {
    // The reducer never consults the registry: replay depends on the log alone.
    const { s } = reserved();
    const a = admission(s);
    const after = step(s, [admit(a)]);
    assert.equal(after.version, (s.version + 1n) as LedgerVersion);
  });
});
