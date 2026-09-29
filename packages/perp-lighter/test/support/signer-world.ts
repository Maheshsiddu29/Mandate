/**
 * Offline fakes and a full issuance world for the Lighter signer tests: the
 * SQLite reference store, the control engine, a fake key custody that checks
 * the ledger at every signature (the key-use probe), a scriptable fake venue,
 * and a fixed clock. The fake custody's hash is a stand-in (keccak of the
 * transaction's canonical JSON, cut to Lighter's 40 bytes) — the real hash is
 * the Go custody's, exercised by `npm run lighter:custody:check`.
 */

import assert from 'node:assert/strict';
import { keccakDigest, type Digest32 } from '@mandate/core';
import type { AttemptRecord, LedgerState } from '@mandate/ledger';
import { DurableAdapterRegistry, DurableModuleRegistry, IssuanceJournal, SqliteLedgerStore, openLifecycle, type LifecycleTable } from '@mandate/ledger-sqlite';
import type { AuthorizationRecord } from '@mandate/control';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWED_TX_TYPES,
  ARTIFACT_KIND,
  createPerpPolicy,
  slotScope,
  VenueSigner,
  custodyJson,
  lighterAdapterRef,
  type AttemptClaim,
  type CustodyResult,
  type CustodyTx,
  type HashedTx,
  type KeyCustody,
  type RegisteredKey,
  type SignedTx,
  type SignerDeps,
  type Submission,
  type VenueClient,
  type VenueRead,
} from '../../src/index.ts';
import { API_KEY_INDEX, CHAIN, CONFIG, ONCE, P, RETRY, SUB_ACCOUNT, T, authorized, btcNotionalDim, btcSizeDim, context, marginDim, must, order, perpWorld, policy, request, root, setup, states, type PerpWorld } from './world.ts';
import { validatePrincipalId } from '@mandate/core';

export const PUBLIC_KEY = 'ab'.repeat(40);
/** Signer clock: T + 5 s, in ms. */
export const NOW_MS = (T + 5n) * 1_000n;

export function fakeHash(tx: CustodyTx): string {
  return keccakDigest(new TextEncoder().encode(JSON.stringify(custodyJson(tx)))).slice(2, 82).padEnd(80, '0');
}

export interface SignCall {
  readonly tx: CustodyTx;
  /** Custody's own hash of `tx`. */
  readonly hash: string;
  readonly claim: AttemptClaim | null;
  /** At the moment of the request: the committed attempts whose artifact is this hash. */
  readonly boundTo: readonly AttemptRecord[];
  /** Whether custody produced a signature. */
  readonly signed: boolean;
  readonly refusal: string | null;
}

/**
 * How the fake custody decides. `DURABLE` mirrors the Go custody (ledger.go):
 * it reads the committed ledger itself and signs only its own hash of `tx`
 * when that is exactly the claimed attempt's committed artifact. The others
 * are mutants: M12 trusts that the transaction is the admitted one once the
 * attempt exists; M13 signs with no attempt at all.
 */
export type CustodyVerification = 'DURABLE' | 'TRUST_CALLER_HASH' | 'NO_ATTEMPT_REQUIRED';

export interface FakeCustodyOptions {
  readonly ledger: () => LedgerState;
  readonly issued: (attempt: string) => boolean;
  readonly lifecycle: (kind: 'MODULE' | 'ADAPTER', name: string, version: number) => { status: string; digest: string } | null;
  readonly clockMs: () => bigint;
  readonly verification?: CustodyVerification;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A key custody stand-in that records every request and verifies it against the committed ledger, as the Go custody does. */
export class FakeCustody implements KeyCustody {
  readonly hashes: CustodyTx[] = [];
  readonly signs: SignCall[] = [];
  readonly #o: FakeCustodyOptions;
  readonly #slots = new Map<string, string>();
  onSign: (() => void) | null = null;
  onHash: (() => void) | null = null;
  publicKeyValue = PUBLIC_KEY;
  verification: CustodyVerification;

  constructor(o: FakeCustodyOptions) {
    this.#o = o;
    this.verification = o.verification ?? 'DURABLE';
  }

  async publicKey(): Promise<CustodyResult<string>> {
    return { ok: true, value: this.publicKeyValue };
  }

  async hash(tx: CustodyTx): Promise<CustodyResult<HashedTx>> {
    this.hashes.push(tx);
    this.onHash?.();
    if (!(ALLOWED_TX_TYPES as readonly string[]).includes(tx.type)) return { ok: false, error: 'TX_TYPE_FORBIDDEN' };
    return { ok: true, value: { hash: fakeHash(tx), txType: tx.type === 'CREATE_ORDER' ? 14 : 15 } };
  }

  /** The Go custody's `VerifyAdmitted`, over the committed ledger state. */
  verify(claim: AttemptClaim | null, tx: CustodyTx, hash: string): string | null {
    if (this.verification === 'NO_ATTEMPT_REQUIRED') return null;
    if (claim === null || claim.attempt === '') return 'ATTEMPT_ID_MISSING';
    const state = this.#o.ledger();
    const a = state.attempts.get(claim.attempt);
    if (a === undefined) return 'ATTEMPT_NOT_ADMITTED';
    if (this.verification === 'TRUST_CALLER_HASH') return null;
    const policy = CONFIG_REFS.module();
    if (a.module.moduleDigest !== policy.moduleDigest || a.module.moduleId !== policy.moduleId) return 'MODULE_NOT_SERVED';
    if (a.adapter.adapterDigest !== CONFIG_REFS.adapter.adapterDigest) return 'ADAPTER_NOT_SERVED';
    if (a.reservation !== claim.reservation || a.generation !== claim.generation || a.action !== claim.action) return 'RESERVATION_MISMATCH';
    if (a.venueAccount.localId !== `lighter:${CHAIN}:account:${SUB_ACCOUNT}`) return 'ACCOUNT_MISMATCH';
    if (a.artifact.kind !== ARTIFACT_KIND || hex(a.artifact.id) !== hash) return 'ARTIFACT_NOT_ADMITTED';
    if (a.slot === null || a.slot.scope !== slotScope(CHAIN, SUB_ACCOUNT, API_KEY_INDEX) || a.slot.sequence !== tx.nonce) return 'SLOT_MISMATCH';
    if (this.#o.clockMs() >= a.validUntil * 1_000n || tx.expiredAt > a.validUntil * 1_000n) return 'ATTEMPT_EXPIRED';
    if (state.reservations.get(a.reservation)?.status !== 'ACTIVE') return 'RESERVATION_CLOSED';
    if (this.#o.issued(claim.attempt)) return 'ATTEMPT_ALREADY_ISSUED';
    for (const [kind, name, version, digest] of [['MODULE', policy.moduleId, policy.moduleVersion, policy.moduleDigest], ['ADAPTER', CONFIG_REFS.adapter.adapterId, CONFIG_REFS.adapter.adapterVersion, CONFIG_REFS.adapter.adapterDigest]] as const) {
      const lc = this.#o.lifecycle(kind, name, version);
      if (lc === null) return `${kind}_LIFECYCLE_UNKNOWN`;
      if (lc.digest !== digest) return `${kind}_LIFECYCLE_OTHER_DIGEST`;
      if (lc.status !== 'ACTIVE' && lc.status !== 'RETIRING') return `${kind}_${lc.status}`;
    }
    return null;
  }

  async sign(tx: CustodyTx, claim: AttemptClaim | null): Promise<CustodyResult<SignedTx>> {
    const hash = fakeHash(tx);
    const boundTo = [...this.#o.ledger().attempts.values()].filter((a) => a.artifact.kind === ARTIFACT_KIND && hex(a.artifact.id) === hash);
    const record = (signed: boolean, refusal: string | null) => this.signs.push({ tx, hash, claim, boundTo, signed, refusal });
    this.onSign?.();
    if (!(ALLOWED_TX_TYPES as readonly string[]).includes(tx.type)) {
      record(false, 'TX_TYPE_FORBIDDEN');
      return { ok: false, error: 'TX_TYPE_FORBIDDEN' };
    }
    const refusal = this.verify(claim, tx, hash);
    if (refusal !== null) {
      record(false, refusal);
      return { ok: false, error: refusal };
    }
    const slot = tx.nonce.toString();
    if (this.#slots.has(slot) && this.#slots.get(slot) !== hash) {
      record(false, 'SLOT_ALREADY_SIGNED');
      return { ok: false, error: 'SLOT_ALREADY_SIGNED' };
    }
    this.#slots.set(slot, hash);
    record(true, null);
    return { ok: true, value: { hash, txType: tx.type === 'CREATE_ORDER' ? 14 : 15, txInfo: JSON.stringify({ ...custodyJson(tx), Sig: 'fake-signature' }) } };
  }

  close(): void {}
}

/** The module and adapter this custody serves (set by `issuanceWorld`). */
const CONFIG_REFS: { module: () => { moduleId: string; moduleVersion: number; moduleDigest: string }; adapter: { adapterId: string; adapterVersion: number; adapterDigest: string } } = {
  module: () => createPerpPolicy(CONFIG).ref,
  adapter: lighterAdapterRef({ chainId: CHAIN }),
};

export type SendBehaviour = 'ACK' | 'REJECT' | 'UNKNOWN' | 'ACK_OTHER_HASH';

export class FakeVenue implements VenueClient {
  keys: RegisteredKey[] = [{ apiKeyIndex: API_KEY_INDEX, publicKey: PUBLIC_KEY }];
  next = 0n;
  send: SendBehaviour = 'ACK';
  readonly sent: { txType: number; txInfo: string }[] = [];
  onSend: (() => void) | null = null;

  async apiKeys(): Promise<VenueRead<readonly RegisteredKey[]>> {
    return { ok: true, value: this.keys, raw: JSON.stringify(this.keys) };
  }

  async nextNonce(): Promise<VenueRead<bigint>> {
    return { ok: true, value: this.next, raw: String(this.next) };
  }

  async sendTx(txType: number, txInfo: string): Promise<Submission> {
    this.sent.push({ txType, txInfo });
    this.onSend?.();
    const hash = fakeHashOfInfo(txInfo);
    switch (this.send) {
      case 'ACK':
        return { kind: 'ACK', txHash: hash, raw: '{"code":200}' };
      case 'ACK_OTHER_HASH':
        return { kind: 'ACK', txHash: '00'.repeat(40), raw: '{"code":200}' };
      case 'REJECT':
        return { kind: 'REJECTED', code: 21_104, message: 'invalid nonce', raw: '{"code":21104}' };
      case 'UNKNOWN':
        return { kind: 'UNKNOWN', error: 'TimeoutError' };
    }
  }
}

function fakeHashOfInfo(txInfo: string): string {
  const { Sig: _sig, ...rest } = JSON.parse(txInfo) as { Sig: string; [k: string]: string | number };
  return keccakDigest(new TextEncoder().encode(JSON.stringify(rest))).slice(2, 82).padEnd(80, '0');
}

export interface IssuanceWorld {
  readonly w: PerpWorld;
  readonly store: SqliteLedgerStore;
  readonly journal: IssuanceJournal;
  readonly custody: FakeCustody;
  readonly venue: FakeVenue;
  readonly signer: VenueSigner;
  readonly deps: SignerDeps;
  readonly g: ReturnType<typeof root>;
  readonly path: string;
  readonly lifecycle: LifecycleTable;
  /** The signer's clock, in ms; tests move it forward. */
  clock: { ms: bigint };
  close(): void;
}

export interface IssuanceOptions {
  readonly path?: string;
  readonly moduleStatus?: 'ACTIVE' | 'RETIRING' | 'DISABLED';
  readonly adapterStatus?: 'ACTIVE' | 'RETIRING' | 'DISABLED';
  /** Skip policy and grant registration: the file already holds them. */
  readonly reopen?: boolean;
  readonly clockMs?: bigint;
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-perp-lighter-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function issuanceWorld(o: IssuanceOptions = {}): Promise<IssuanceWorld> {
  const tmp = o.path === undefined ? tempDir() : null;
  const path = o.path ?? join((tmp as { dir: string }).dir, 'ledger.db');
  let store: SqliteLedgerStore | null = null;
  // One durable lifecycle source for Control and custody, in the ledger's own file.
  const lifecycle = openLifecycle(path);
  const perp = createPerpPolicy(CONFIG);
  lifecycle.table.setModule({ module: perp.ref, status: o.moduleStatus ?? 'ACTIVE', implementations: [perp.implementation] });
  lifecycle.table.setAdapter({ adapter: lighterAdapterRef({ chainId: CHAIN }), status: o.adapterStatus ?? 'ACTIVE' });
  const w = perpWorld({
    policy: perp,
    registries: { modules: new DurableModuleRegistry(lifecycle.table), adapters: new DurableAdapterRegistry(lifecycle.table) },
    storeOf: (rules) => (store = SqliteLedgerStore.open({ path, rules })),
  });
  const s = store as unknown as SqliteLedgerStore;
  const g = root(w, [btcSizeDim(1_000_000n), btcNotionalDim(10n ** 12n), marginDim(10n ** 12n)]);
  if (o.reopen !== true) await setup(w, policy(), [g]);
  const principal = must(validatePrincipalId(P, 'p'));
  const journal = new IssuanceJournal(s);
  const clock = { ms: o.clockMs ?? NOW_MS };
  const custody = new FakeCustody({
    ledger: () => s.readCommitted(principal).state,
    issued: (attempt) => journal.get(attempt as never) !== null,
    lifecycle: (kind, name, version) => {
      const row = lifecycle.table.read(kind, name, version);
      return row === null ? null : { status: row.status, digest: (JSON.parse(row.ref) as { moduleDigest?: string; adapterDigest?: string }).moduleDigest ?? (JSON.parse(row.ref) as { adapterDigest: string }).adapterDigest };
    },
    clockMs: () => clock.ms,
  });
  const venue = new FakeVenue();
  const deps: SignerDeps = {
    engine: w.engine,
    store: s,
    journal,
    custody,
    venue,
    clock: () => clock.ms,
    config: { chainId: CHAIN, accountIndex: SUB_ACCOUNT, apiKeyIndex: API_KEY_INDEX, principal, adapter: lighterAdapterRef({ chainId: CHAIN }), policy: w.policy.ref, txTtlMs: 599_000n, retry: RETRY },
  };
  return { w, store: s, journal, custody, venue, signer: new VenueSigner(deps), deps, g, path, clock, lifecycle: lifecycle.table, close: () => { s.close(); lifecycle.close(); tmp?.cleanup(); } };
}

/** Authorize a BUY and return the record with the request its issuance needs. */
export async function authorizeOrder(x: IssuanceWorld, o: Parameters<typeof order>[2] = {}, at: bigint = T) {
  const a = order(x.w, x.g, o);
  const rec = authorized(await x.w.engine.authorizeAndReserve(request(a, states(x.w, { at }), context(at)), ONCE));
  // The signer issues 5 s later, on fresh state.
  x.clock.ms = (at + 5n) * 1_000n;
  return { rec, a, issue: { payload: a.payload, states: states(x.w, { at: at + 5n }), context: context(at + 5n) } };
}

/** An authorization record through JSON and back — how a crashed process's caller would hold it. */
export function recordToJson(r: AuthorizationRecord): string {
  return JSON.stringify(r, (_k, v: bigint | string | Uint8Array) => (typeof v === 'bigint' ? { $big: v.toString() } : v instanceof Uint8Array ? { $bytes: [...v] } : v));
}

export function recordFromJson(text: string): AuthorizationRecord {
  return JSON.parse(text, (_k, v: { $big?: string; $bytes?: number[] } | string) => (typeof v === 'object' && v !== null && typeof v.$big === 'string' ? BigInt(v.$big) : typeof v === 'object' && v !== null && Array.isArray(v.$bytes) ? new Uint8Array(v.$bytes) : v)) as AuthorizationRecord;
}

export function noSignature(x: IssuanceWorld, why: string): void {
  assert.equal(x.custody.signs.length, 0, `${why}: the key was used`);
}

export const EVIDENCE_OK = keccakDigest<Digest32>(new TextEncoder().encode('evidence'));
