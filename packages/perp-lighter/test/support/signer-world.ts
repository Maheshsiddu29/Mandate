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
import { IssuanceJournal, SqliteLedgerStore } from '@mandate/ledger-sqlite';
import type { AuthorizationRecord } from '@mandate/control';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOWED_TX_TYPES,
  ARTIFACT_KIND,
  VenueSigner,
  custodyJson,
  lighterAdapterRef,
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
import { API_KEY_INDEX, CHAIN, ONCE, P, RETRY, SUB_ACCOUNT, T, authorized, btcNotionalDim, btcSizeDim, context, marginDim, must, order, perpWorld, policy, request, root, setup, states, type PerpWorld } from './world.ts';
import { validatePrincipalId } from '@mandate/core';

export const PUBLIC_KEY = 'ab'.repeat(40);
/** Signer clock: T + 5 s, in ms. */
export const NOW_MS = (T + 5n) * 1_000n;

export function fakeHash(tx: CustodyTx): string {
  return keccakDigest(new TextEncoder().encode(JSON.stringify(custodyJson(tx)))).slice(2, 82).padEnd(80, '0');
}

export interface SignCall {
  readonly tx: CustodyTx;
  readonly hash: string;
  /** At the moment of signing: the attempts in the committed ledger whose artifact is this hash. */
  readonly boundTo: readonly AttemptRecord[];
}

/** A key custody stand-in that records every call and, at each signature, what the committed ledger said. */
export class FakeCustody implements KeyCustody {
  readonly hashes: CustodyTx[] = [];
  readonly signs: SignCall[] = [];
  readonly #ledger: () => LedgerState;
  readonly #slots = new Map<string, string>();
  onSign: (() => void) | null = null;
  publicKeyValue = PUBLIC_KEY;

  constructor(ledger: () => LedgerState) {
    this.#ledger = ledger;
  }

  async publicKey(): Promise<CustodyResult<string>> {
    return { ok: true, value: this.publicKeyValue };
  }

  onHash: (() => void) | null = null;

  async hash(tx: CustodyTx): Promise<CustodyResult<HashedTx>> {
    this.hashes.push(tx);
    this.onHash?.();
    if (!(ALLOWED_TX_TYPES as readonly string[]).includes(tx.type)) return { ok: false, error: 'TX_TYPE_FORBIDDEN' };
    return { ok: true, value: { hash: fakeHash(tx), txType: tx.type === 'CREATE_ORDER' ? 14 : 15 } };
  }

  async sign(tx: CustodyTx, expectedHash: string, attempt: string): Promise<CustodyResult<SignedTx>> {
    const hash = fakeHash(tx);
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    const boundTo = [...this.#ledger().attempts.values()].filter((a) => a.artifact.kind === ARTIFACT_KIND && hex(a.artifact.id) === hash);
    this.signs.push({ tx, hash, boundTo });
    this.onSign?.();
    if (hash !== expectedHash) return { ok: false, error: 'HASH_NOT_COMMITTED' };
    if (!(ALLOWED_TX_TYPES as readonly string[]).includes(tx.type)) return { ok: false, error: 'TX_TYPE_FORBIDDEN' };
    const slot = tx.nonce.toString();
    if (this.#slots.has(slot) && this.#slots.get(slot) !== hash) return { ok: false, error: 'SLOT_ALREADY_SIGNED' };
    this.#slots.set(slot, hash);
    void attempt;
    return { ok: true, value: { hash, txType: tx.type === 'CREATE_ORDER' ? 14 : 15, txInfo: JSON.stringify({ ...custodyJson(tx), Sig: 'fake-signature' }) } };
  }

  close(): void {}
}

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
  const w = perpWorld({
    storeOf: (rules) => (store = SqliteLedgerStore.open({ path, rules })),
    ...(o.moduleStatus === undefined ? {} : { moduleStatus: o.moduleStatus }),
    ...(o.adapterStatus === undefined ? {} : { adapterStatus: o.adapterStatus }),
  });
  const s = store as unknown as SqliteLedgerStore;
  const g = root(w, [btcSizeDim(1_000_000n), btcNotionalDim(10n ** 12n), marginDim(10n ** 12n)]);
  if (o.reopen !== true) await setup(w, policy(), [g]);
  const principal = must(validatePrincipalId(P, 'p'));
  const journal = new IssuanceJournal(s);
  const custody = new FakeCustody(() => s.readCommitted(principal).state);
  const venue = new FakeVenue();
  const clock = { ms: o.clockMs ?? NOW_MS };
  const deps: SignerDeps = {
    engine: w.engine,
    store: s,
    journal,
    custody,
    venue,
    clock: () => clock.ms,
    config: { chainId: CHAIN, accountIndex: SUB_ACCOUNT, apiKeyIndex: API_KEY_INDEX, principal, adapter: lighterAdapterRef({ chainId: CHAIN }), policy: w.policy.ref, txTtlMs: 599_000n, retry: RETRY },
  };
  return { w, store: s, journal, custody, venue, signer: new VenueSigner(deps), deps, g, path, clock, close: () => { s.close(); tmp?.cleanup(); } };
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
