/**
 * Restoring a durable session (docs/demo/wallet-settlement-boundaries.md §4).
 *
 * The portfolio ledger is the authority; `session.db` is the record of what
 * the session did. Restore rebuilds each version from its canonical mandate
 * encoding, re-checks it, and asks the ledger what is true:
 *
 * - the mandate re-encodes to the recorded digest and carries a valid
 *   protocol signature, and its root is registered in the ledger;
 * - a version recorded ACTIVE whose root the ledger has revoked (a crash
 *   between a revocation and its record) is restored REVOKED, and the session
 *   paused — never re-activated;
 * - any reservation in the ledger means the session has reserved, whatever
 *   the flag says;
 * - every recorded reserved execution names a reservation the ledger holds;
 *   a ledger reservation with no recorded execution (a crash between the
 *   reservation and its record) is reported as an orphan and is never
 *   settled: there is nothing to verify it against.
 *
 * Restoring restores evidence, never authority: nothing here reserves,
 * releases or signs anything new.
 */

import { authorityId } from '@mandate/core';
import { createPortfolioCore, decodePortfolioMandate, mandateSignedByPrincipal, mandateSignedByPrincipalV2, mandateSignedByPrincipalV2Plan, portfolioMandateDigest, type DomainBinding, type PortfolioCore, type PortfolioMandate } from '@mandate/portfolio';
import { normalizeDraft, type MandateDraft } from '../authoring/draft-types.ts';
import type { RestoredVersion, VersionRecord } from '../authoring/mandate-versioning.ts';
import { compile } from '../mandate/portfolio-adapter.ts';
import type { ReservedExecution } from '../session.ts';
import { APPROVAL_CHAIN_ID, sessionDigest, type ApprovalMessage } from '../wallet/approval.ts';
import { decodeRecord } from './codec.ts';
import { SessionStoreCorruption, type SessionStore } from './session-store.ts';

export interface RestoredState {
  readonly versions: readonly RestoredVersion[];
  readonly paused: boolean;
  readonly reserved: boolean;
  readonly reservedExecutions: readonly ReservedExecution[];
  /** Ledger reservations with no recorded execution: quarantined, never settled. */
  readonly orphans: readonly string[];
  readonly approvals: ReadonlyMap<number, { readonly message: ApprovalMessage; readonly signature: string }>;
  /** The latest protocol time anything durable carries: restored time never runs below it. */
  readonly protocolFloor: bigint;
  readonly draft: MandateDraft | null;
}

function bytes(h: string): Uint8Array {
  if (!/^0x([0-9a-f]{2})+$/.test(h)) throw new SessionStoreCorruption('mandate encoding is not hex');
  const body = h.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function decoded<T>(text: string, what: string): T {
  try {
    return decodeRecord<T>(text);
  } catch {
    throw new SessionStoreCorruption(`${what} undecodable`);
  }
}

/** V1: the raw prehash. V2: the wallet EIP-712 signature, and only that, for this session. */
function protocolSignatureHolds(sessionId: string, mandate: PortfolioMandate, record: VersionRecord, signature: string): boolean {
  if (record.authorization.method !== 'WALLET_PRINCIPAL_V2' && record.authorization.method !== 'WALLET_PRINCIPAL_V2_PLAN') return mandateSignedByPrincipal(mandate, signature);
  const a = record.authorization;
  const bound = sessionDigest(sessionId);
  if (a.domainDelegation !== 'SAME_PRINCIPAL' || a.protocolSigner !== a.principal) return false;
  if (mandate.principal.kind !== 'eip155-address' || mandate.principal.value !== a.principal) return false;
  if (a.wallet?.chainId !== APPROVAL_CHAIN_ID.toString() || a.wallet.sessionDigest !== bound) return false;
  if (record.authorization.method === 'WALLET_PRINCIPAL_V2_PLAN') {
    const initialAllocationDigest = a.wallet?.initialAllocationDigest;
    return initialAllocationDigest !== undefined && mandateSignedByPrincipalV2Plan(mandate, signature, { chainId: APPROVAL_CHAIN_ID, sessionDigest: bound, initialAllocationDigest });
  }
  return mandateSignedByPrincipalV2(mandate, signature, { chainId: APPROVAL_CHAIN_ID, sessionDigest: bound });
}

export async function restoreState(store: SessionStore, bindings: readonly DomainBinding[]): Promise<RestoredState> {
  const versions: RestoredVersion[] = [];
  let first: PortfolioCore | null = null;
  let paused = store.flags().paused;
  for (const row of store.versions()) {
    const m = decodePortfolioMandate(bytes(row.mandateHex));
    if (!m.ok) throw new SessionStoreCorruption(`V${row.version}: mandate does not decode (${m.error.code})`);
    let record = decoded<VersionRecord>(row.record, `V${row.version} record`);
    if (record.version !== row.version || portfolioMandateDigest(m.value) !== record.digest) throw new SessionStoreCorruption(`V${row.version}: digest mismatch`);
    if (row.signature !== record.signature || !protocolSignatureHolds(store.meta.sessionId, m.value, record, row.signature)) throw new SessionStoreCorruption(`V${row.version}: protocol signature invalid`);
    const c = compile(m.value, bindings);
    if (!c.ok) throw new SessionStoreCorruption(`V${row.version}: does not compile`);
    const base: PortfolioCore | null = first;
    const core: PortfolioCore = base === null ? createPortfolioCore(c.compiled, { storeOf: store.ledgerStoreOf }) : createPortfolioCore(c.compiled, { storeOf: () => base.store, registries: { modules: base.registry, adapters: base.adapters } });
    first ??= core;
    const state = (await core.engine.read(m.value.principal)).state;
    const root = state.nodes.get(authorityId(c.compiled.root));
    if (root === undefined) throw new SessionStoreCorruption(`V${row.version}: root not in the ledger`);
    if (record.status === 'ACTIVE' && root.revokedAt !== null) {
      // Revoked in the ledger, recorded active: the ledger wins, and nothing is re-activated.
      record = { ...record, status: 'REVOKED' };
      paused = true;
    }
    if (record.status !== 'ACTIVE' && root.revokedAt === null) throw new SessionStoreCorruption(`V${row.version}: recorded ${record.status} but its root is live in the ledger`);
    versions.push({ record, active: { version: row.version, mandate: m.value, compiled: c.compiled, core, signature: row.signature, draft: normalizeDraft(decoded<MandateDraft>(row.draft, `V${row.version} draft`)) } });
  }

  let reserved = store.flags().reserved;
  let protocolFloor = 0n;
  const reservedExecutions: ReservedExecution[] = store.reserved().map((j) => decoded<ReservedExecution>(j, 'reserved execution'));
  const orphans: string[] = [];
  if (first !== null) {
    const state = (await first.engine.read(first.compiled.mandate.principal)).state;
    if (state.lastAt !== null) protocolFloor = state.lastAt;
    const recorded = new Set(reservedExecutions.map((x) => x.record.reservation as string));
    for (const x of reservedExecutions) if (state.reservations.get(x.record.reservation) === undefined) throw new SessionStoreCorruption(`reservation ${x.record.reservation} is not in the ledger`);
    for (const r of state.reservations.values()) {
      reserved = true;
      if (!recorded.has(r.id)) orphans.push(r.id);
    }
  }
  const events = store.eventsAfter(-1);
  const lastEvent = events[events.length - 1];
  if (lastEvent !== undefined && BigInt(lastEvent.protocolTime) > protocolFloor) protocolFloor = BigInt(lastEvent.protocolTime);
  const approvals = new Map(store.approvals().map((a) => [a.version, { message: decoded<ApprovalMessage>(a.message, `V${a.version} approval`), signature: a.signature }] as const));
  return { versions, paused, reserved, reservedExecutions, orphans: orphans.sort(), approvals, protocolFloor, draft: decoded<MandateDraft | null>(store.draft(), 'draft') };
}
