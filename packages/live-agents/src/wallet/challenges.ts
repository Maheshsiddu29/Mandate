/**
 * One-time wallet authorization challenges.
 *
 * A challenge binds, server-side, one exact prepared mandate (its digest
 * fixed), one version, one session, one claimed wallet address and 32
 * random bytes. It may be signed and submitted once, before it expires, for
 * that version only, while the session's draft is still the one it was
 * issued for. Five bad signatures lock it. A successful authorization
 * consumes it before the version is committed, so it can never authorize
 * twice — not even if the commit then fails.
 */

import type { MandateDraft } from '../authoring/draft-types.ts';
import type { InitialAllocationPlan } from '@mandate/portfolio';
import type { PreparedVersion } from '../authoring/mandate-versioning.ts';
import type { ApprovalMessage } from './approval.ts';

export const MAX_SIGNATURE_FAILURES = 5;

export interface WalletChallenge {
  /** The challenge bytes32, 0x-prefixed: also its id. */
  readonly id: string;
  readonly sessionId: string;
  readonly prepared: PreparedVersion;
  /**
   * `V1`: the B.5.3 approval (`message` is set). `V2`: the wallet is the
   * protocol principal and `message` is null — the signed bytes are rebuilt
   * from the prepared mandate.
   */
  readonly spine: 'V1' | 'V2';
  readonly message: ApprovalMessage | null;
  /** Present only for the plan-bound V2 primary type. */
  readonly initialAllocation: InitialAllocationPlan | null;
  readonly initialAllocationDigest: string | null;
  /** Wall-clock unix seconds. The challenge may be submitted in `[issuedAt, deadline)`. */
  readonly issuedAt: bigint;
  readonly deadline: bigint;
  /** The draft it was issued for, canonically serialized. */
  readonly draftKey: string;
  readonly failures: number;
  readonly consumed: boolean;
}

/** Durable sessions record every issue and change (persistence/session-store.ts). */
export interface ChallengePersistence {
  onChallenge(c: WalletChallenge): void;
}

/** JSON with object keys sorted, so two equal drafts always serialize equal. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as { readonly [k: string]: unknown };
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function draftKey(d: MandateDraft): string {
  return canonicalJson(d);
}

export class ChallengeBook {
  readonly #byId = new Map<string, WalletChallenge>();
  readonly #persist: ChallengePersistence | null;

  constructor(o: { readonly persist?: ChallengePersistence; readonly restored?: readonly WalletChallenge[] } = {}) {
    this.#persist = o.persist ?? null;
    for (const c of o.restored ?? []) this.#byId.set(c.id, c);
  }

  issue(c: WalletChallenge): void {
    if (this.#byId.has(c.id)) throw new Error('challenge id collision');
    this.#byId.set(c.id, c);
    this.#persist?.onChallenge(c);
  }

  get(id: string): WalletChallenge | null {
    return this.#byId.get(id) ?? null;
  }

  failed(id: string): void {
    this.#update(id, (c) => ({ ...c, failures: c.failures + 1 }));
  }

  consume(id: string): void {
    this.#update(id, (c) => ({ ...c, consumed: true }));
  }

  #update(id: string, f: (c: WalletChallenge) => WalletChallenge): void {
    const c = this.#byId.get(id);
    if (c === undefined) return;
    const next = f(c);
    this.#byId.set(id, next);
    this.#persist?.onChallenge(next);
  }
}
