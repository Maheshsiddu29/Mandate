/**
 * The Live AI Lab's only door into the Mandate protocol.
 *
 * Every call here is the frozen public API of `@mandate/portfolio`, the
 * control engine and the ledger, used exactly as the Phase 7F demonstration
 * and the judge demo use it. Nothing decides anything on its own:
 *
 * - a mandate version is compiled, registered and — when superseded —
 *   its root revoked by the ledger's existing `REVOKE` event;
 * - a proposed portfolio is handed to `runPortfolio`: the real Mandate
 *   Room screens it, the Portfolio Verifier re-derives it, the ledger
 *   reserves it, the domain executors run what is theirs;
 * - `FixedProposalStrategy` is how an already-signed proposal enters that
 *   synchronous Room: it proposes once and never adapts. The Room's own
 *   REDUCE_REQUESTED therefore never becomes a silent resize.
 */

import { authorityId, partyIdInputOf } from '@mandate/core';
import { controlRules, type AuthorizationRecord } from '@mandate/control';
import { AuthorityLedger, attemptsOf, validateRevocation, type LedgerStore, type ReducerRules } from '@mandate/ledger';
import {
  availabilityFrom,
  compilePortfolio,
  createPortfolioCore,
  defaultExecutor,
  registerPortfolio,
  runPortfolio,
  type AgentMessage,
  type AgentStrategy,
  type ChildExecutor,
  type CompiledPortfolio,
  type DomainBinding,
  type PortfolioAuthority,
  type PortfolioCore,
  type PortfolioMandate,
  type PortfolioRun,
  type Reason,
  type ResourceAvailability,
  type SignedProposal,
  type VerificationTranscript,
  type VerifiedChild,
} from '@mandate/portfolio';
import { demoBindings } from '@mandate/portfolio/demo';

/** The five reviewed domain bindings. One set per session, shared by every version, so every version compiles the same modules. */
export function sessionBindings(): readonly DomainBinding[] {
  return demoBindings();
}

export type Registered = { readonly ok: true; readonly core: PortfolioCore; readonly ledgerVersion: bigint } | { readonly ok: false; readonly reasons: readonly Reason[] };

export function compile(m: PortfolioMandate, bindings: readonly DomainBinding[]): { readonly ok: true; readonly compiled: CompiledPortfolio } | { readonly ok: false; readonly reasons: readonly Reason[] } {
  const c = compilePortfolio(m, bindings);
  return c.ok ? { ok: true, compiled: c.value } : { ok: false, reasons: c.error };
}

/** Register a first version in a fresh ledger: in memory, or the durable store `storeOf` builds. */
export async function registerFirst(compiled: CompiledPortfolio, at: bigint, storeOf?: (rules: ReducerRules) => LedgerStore): Promise<Registered> {
  const core = createPortfolioCore(compiled, storeOf === undefined ? {} : { storeOf });
  const r = await registerPortfolio(core, at);
  return r.ok ? { ok: true, core, ledgerVersion: r.value.version } : { ok: false, reasons: r.error };
}

/** Register a successor version in the *same* ledger as `previous`, through the same module and adapter registries. */
export async function registerSuccessor(previous: PortfolioCore, compiled: CompiledPortfolio, at: bigint): Promise<Registered> {
  const core = createPortfolioCore(compiled, { storeOf: () => previous.store, registries: { modules: previous.registry, adapters: previous.adapters } });
  const r = await registerPortfolio(core, at);
  return r.ok ? { ok: true, core, ledgerVersion: r.value.version } : { ok: false, reasons: r.error };
}

/**
 * Revoke a version's root — and with it every agent delegation below it —
 * through the ledger's own `REVOKE` event, issued by the principal. From
 * then on Core refuses any action under it (`AUTHORITY_REVOKED`).
 */
export async function revokeRoot(core: PortfolioCore, at: bigint, nonce: bigint): Promise<{ readonly ok: true; readonly ledgerVersion: bigint } | { readonly ok: false; readonly reason: string }> {
  const m = core.compiled.mandate;
  const revocation = validateRevocation({ target: authorityId(core.compiled.root), issuer: partyIdInputOf(m.principal), effectiveAt: at, nonce });
  if (!revocation.ok) return { ok: false, reason: `REVOCATION_INVALID:${revocation.error.code}` };
  const ledger = new AuthorityLedger(core.store, core.registry, controlRules(core.catalog));
  const r = await ledger.revoke(m.principal, revocation.value, at, { maxAttempts: 1 });
  if (r.status === 'COMMITTED') return { ok: true, ledgerVersion: r.snapshot.version };
  return { ok: false, reason: r.status === 'REFUSED' ? `LEDGER:${r.refusal.code}` : 'LEDGER:CONFLICT' };
}

export async function availabilityAt(core: PortfolioCore, now: bigint): Promise<ResourceAvailability> {
  return availabilityFrom(core.compiled, await core.engine.read(core.compiled.mandate.principal), now);
}

/** An agent in the synchronous Room that proposes one already-signed proposal, once. */
export class FixedProposalStrategy implements AgentStrategy {
  readonly agent: { readonly kind: string; readonly value: string };
  readonly #signed: SignedProposal;
  #sent = false;

  constructor(signed: SignedProposal) {
    this.agent = { kind: signed.proposal.agent.kind, value: signed.proposal.agent.value };
    this.#signed = signed;
  }

  act(): AgentMessage {
    if (this.#sent) return { kind: 'IDLE' };
    this.#sent = true;
    return { kind: 'PROPOSE', signed: this.#signed };
  }
}

/** The default domain executor, counted: how many verified, reserved children it was asked to run. */
export function countingExecutor(core: PortfolioCore): { readonly execute: ChildExecutor; readonly calls: () => number } {
  const inner = defaultExecutor(core);
  let calls = 0;
  return {
    execute: (v: VerifiedChild, record: AuthorizationRecord, at: bigint, t: VerificationTranscript) => {
      calls += 1;
      return inner(v, record, at, t);
    },
    calls: () => calls,
  };
}

/** Seconds between reservation and execution in a live run: none — see runProtocol. */
export const LIVE_EXECUTE_AFTER_SECONDS = 0n;

export interface ProtocolRun {
  readonly run: PortfolioRun;
  /** Executor calls this run made; each one is for a child the verifier derived and the ledger reserved. */
  readonly executorCalls: number;
  readonly transactions: number;
}

/**
 * One pass through the real Mandate path: Room → Portfolio Verifier →
 * ledger reservation → domain executor. Each proposal enters as its own
 * strategy in round 1; callers pass at most one proposal per agent.
 */
export async function runProtocol(core: PortfolioCore, signature: string, now: bigint, proposals: readonly SignedProposal[], authority?: PortfolioAuthority): Promise<ProtocolRun> {
  const executor = countingExecutor(core);
  // The lab's protocol clock follows real time and the executor runs now, so execution is stamped now. The default
  // (now + 5 s) would put a ledger event in the future and refuse the session's next reservation within five
  // seconds as EVALUATION_TIME_REGRESSED — a refresh or a policy-stress case after the final pass.
  const run = await runPortfolio({ core, signature, ...(authority === undefined ? {} : { authority }), now, agents: proposals.map((s) => new FixedProposalStrategy(s)), execute: executor.execute, executeAfter: LIVE_EXECUTE_AFTER_SECONDS });
  return { run, executorCalls: executor.calls(), transactions: run.receipt.transactions };
}

export interface ReservationView {
  readonly id: string;
  readonly authority: string;
  readonly status: string;
  readonly committedAt: string;
}

/** Every reservation in the principal's ledger, and its version: what a refused proposal must leave untouched. */
export async function ledgerView(core: PortfolioCore): Promise<{ readonly version: string; readonly reservations: readonly ReservationView[] }> {
  const s = await core.engine.read(core.compiled.mandate.principal);
  return {
    version: s.version.toString(),
    reservations: s.state.reservations
      .values()
      .map((r) => ({ id: r.id, authority: r.authority, status: r.status, committedAt: r.committedAt.toString() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

export type LedgerReservationStatus = 'RESERVED' | 'ADMITTED' | 'CONSUMED' | 'RELEASED' | 'UNKNOWN';

/**
 * What the ledger says of one reservation — the only authority on it:
 * ACTIVE with no attempt (RESERVED), ACTIVE with an admitted attempt
 * (ADMITTED: an artifact may exist), CLOSED with consumption (CONSUMED) or
 * without (RELEASED).
 */
export async function reservationLedgerStatus(core: PortfolioCore, reservation: string): Promise<LedgerReservationStatus> {
  const state = (await core.engine.read(core.compiled.mandate.principal)).state;
  const r = state.reservations.get(reservation as never);
  if (r === undefined) return 'UNKNOWN';
  if (r.status === 'CLOSED') return r.demands.some((d) => d.consumed > 0n) ? 'CONSUMED' : 'RELEASED';
  return attemptsOf(state, r.id).length > 0 ? 'ADMITTED' : 'RESERVED';
}
