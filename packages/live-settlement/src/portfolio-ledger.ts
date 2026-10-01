/**
 * The settlement's three writes to the *portfolio* ledger
 * (docs/demo/wallet-settlement-boundaries.md §5) — the authority for the
 * Live AI reservation, now durable.
 *
 * 1. **Admit** — before any domain key is used, the control engine's own
 *    `ADMIT_ATTEMPT` for the reserved Stock child, naming the settlement
 *    binding digest as the artifact. It revalidates the authorization and,
 *    being one per reservation, is what refuses a second settlement of the
 *    same reservation: in a later process, after a restart, whatever any
 *    journal says. (B.5.2 never admitted one.)
 * 2. **Consume** — after a mined receipt with status 1 and verified
 *    postconditions: `CONSUME` of everything reserved and `CLOSE`, in one
 *    batch, naming the receipt's evidence digest as the observation. The
 *    reservation is then closed and fully consumed; nothing can restore it.
 * 3. **Release** — only on definitive evidence that nothing executed (a
 *    reverted receipt, or every artifact past its gate deadline with no
 *    commitment recorded): `CLOSE` of everything reserved.
 *
 * Consume and release use the ledger's accounting primitive
 * (`AuthorityLedger.settle`), the same infrastructure path 7C folds; the
 * decision of *when* is the reconciliation's (reconcile.ts), made only from
 * chain evidence. Each is idempotent: a reservation already closed the same
 * way is reported, never written twice.
 */

import { hexToBytes, validateAdapterRef, validateResourceId, type Digest32, type ObservationId } from '@mandate/core';
import { controlRules } from '@mandate/control';
import { AuthorityLedger, attemptsOf, type LedgerState } from '@mandate/ledger';
import { bindingFor, compileAction, type PortfolioCore } from '@mandate/portfolio';
import type { AuthorizedExecution } from './authorized-execution.ts';

/** The artifact kind of a Live AI testnet settlement attempt in the portfolio ledger. */
export const SETTLEMENT_ARTIFACT_KIND = 'live-ai.testnet-settlement';

export type ReservationStatus = 'RESERVED' | 'ADMITTED' | 'CONSUMED' | 'RELEASED' | 'UNKNOWN';

/** What the ledger says of a reservation: the only authority on it. */
export function reservationStatus(state: LedgerState, reservation: string): ReservationStatus {
  const r = state.reservations.get(reservation as never);
  if (r === undefined) return 'UNKNOWN';
  if (r.status === 'CLOSED') return r.demands.some((d) => d.consumed > 0n) ? 'CONSUMED' : 'RELEASED';
  return attemptsOf(state, r.id).length > 0 ? 'ADMITTED' : 'RESERVED';
}

const hex = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

/** Whether the reservation's admitted attempt, if any, is this settlement's. */
export function admittedFor(state: LedgerState, reservation: string): string | null {
  const a = attemptsOf(state, reservation as never);
  const last = a[a.length - 1];
  if (last === undefined) return null;
  return last.artifact.kind === SETTLEMENT_ARTIFACT_KIND ? hex(last.artifact.id) : 'ANOTHER_ARTIFACT';
}

export type Admission = { readonly ok: true; readonly fresh: boolean } | { readonly ok: false; readonly reason: string };

/** `ADMIT_ATTEMPT` for `x`, naming `binding` as the artifact; `fresh: false` when this settlement's attempt already exists. */
export async function admitSettlement(core: PortfolioCore, x: AuthorizedExecution, binding: Digest32, at: bigint): Promise<Admission> {
  const r = x.reserved;
  const b = bindingFor(core.compiled.bindings, x.candidate.kind);
  if ('refused' in b) return { ok: false, reason: `BINDING_REFUSED.${b.refused.code}` };
  const adapter = validateAdapterRef(b.adapter);
  const account = validateResourceId({ domain: b.domain, kind: 'ACCOUNT', localId: r.verified.child.scope.recipients[0] ?? 'none' }, ['ACCOUNT'] as const, 'venueAccount');
  if (!adapter.ok || !account.ok) return { ok: false, reason: 'ADAPTER_OR_ACCOUNT_INVALID' };
  const compiled = compileAction(core.compiled, r.verified.child, r.verified.candidate);
  if (!compiled.ok) return { ok: false, reason: `COMPILE.${compiled.error.code}` };
  const out = await core.engine.admitAttempt(
    r.record,
    {
      revalidation: { payload: compiled.value.payload, states: b.states(r.verified.candidate, at), context: { evaluationTime: at, sources: [...b.sources()], blockHeads: [], sequenceWatermarks: [] } },
      adapter: adapter.value,
      venueAccount: account.value,
      artifact: { kind: SETTLEMENT_ARTIFACT_KIND as never, id: hexToBytes(binding) },
      slot: null,
      validUntil: r.record.validUntil < at + 120n ? r.record.validUntil : at + 120n,
      requirements: [],
      results: [],
    },
    { maxAttempts: 4 },
  );
  if (out.status === 'ADMITTED') return { ok: true, fresh: true };
  if (out.status === 'EXISTING') {
    const mine = out.attempt.artifact.kind === SETTLEMENT_ARTIFACT_KIND && hex(out.attempt.artifact.id) === binding;
    return mine ? { ok: true, fresh: false } : { ok: false, reason: 'ATTEMPT_FOR_ANOTHER_ARTIFACT' };
  }
  return { ok: false, reason: `${out.refusal.code}.${out.refusal.reason}` };
}

export type Accounting = { readonly ok: true; readonly already: boolean; readonly ledgerVersion: bigint } | { readonly ok: false; readonly reason: string };

async function account(core: PortfolioCore, reservation: string, observation: Digest32, at: bigint, consume: boolean): Promise<Accounting> {
  const principal = core.compiled.mandate.principal;
  const snapshot = await core.engine.read(principal);
  const status = reservationStatus(snapshot.state, reservation);
  if (status === (consume ? 'CONSUMED' : 'RELEASED')) return { ok: true, already: true, ledgerVersion: snapshot.version };
  if (status === 'UNKNOWN' || status === 'CONSUMED' || status === 'RELEASED') return { ok: false, reason: `RESERVATION_${status}` };
  const r = snapshot.state.reservations.get(reservation as never);
  if (r === undefined) return { ok: false, reason: 'RESERVATION_UNKNOWN' };
  const ledger = new AuthorityLedger(core.store, core.registry, controlRules(core.catalog));
  const evidence = observation as ObservationId;
  const effects = consume
    ? [
        { kind: 'CONSUME' as const, reservation: r.id, generation: r.generation, evidence, amounts: r.demands.map((d) => d.reserved - d.consumed) },
        { kind: 'CLOSE' as const, reservation: r.id, generation: r.generation, evidence },
      ]
    : [{ kind: 'CLOSE' as const, reservation: r.id, generation: r.generation, evidence }];
  const at_ = snapshot.state.lastAt !== null && snapshot.state.lastAt > at ? snapshot.state.lastAt : at;
  const out = await ledger.settle(principal, effects, at_, { maxAttempts: 4 });
  if (out.status === 'COMMITTED') return { ok: true, already: false, ledgerVersion: out.snapshot.version };
  // Lost a race to an identical write: re-read and accept only the outcome asked for.
  const again = reservationStatus((await core.engine.read(principal)).state, reservation);
  if (again === (consume ? 'CONSUMED' : 'RELEASED')) return { ok: true, already: true, ledgerVersion: (await core.engine.read(principal)).version };
  return { ok: false, reason: out.status === 'REFUSED' ? `LEDGER.${out.refusal.code}` : 'LEDGER.CONFLICT' };
}

/** Consume everything reserved and close: the economic execution happened, durably accounted. */
export function consumeReservation(core: PortfolioCore, reservation: string, observation: Digest32, at: bigint): Promise<Accounting> {
  return account(core, reservation, observation, at, true);
}

/** Release everything reserved: only on definitive evidence that nothing executed. */
export function releaseReservation(core: PortfolioCore, reservation: string, observation: Digest32, at: bigint): Promise<Accounting> {
  return account(core, reservation, observation, at, false);
}
