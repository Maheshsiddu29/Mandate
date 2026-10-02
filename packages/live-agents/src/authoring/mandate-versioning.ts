/**
 * Mandate versions (docs/demo/live-ai-lab.md §3).
 *
 * The only path from a draft to authority:
 *
 * ```text
 * authorize(draft, "AUTHORIZE MANDATE V<n>")                 the demonstration principal key path
 *   ─▶ the confirmation is exactly the next version's ─▶ prepare ─▶ commit
 * prepare(draft) ─▶ the draft validates with no blocking issue ─▶ compile      one exact mandate, digest fixed
 * commit(prepared, authorization)                             the wallet path commits what the wallet signed
 *   ─▶ still the next version, nothing reserved, not paused, not expired
 *   ─▶ (V2+) revoke the active root in the ledger ─▶ register ─▶ protocol signature ─▶ ACTIVE
 * ```
 *
 * A wallet-approved version commits exactly the mandate prepared when its
 * challenge was issued — never one rebuilt later, whose `expiresAt` (and so
 * digest) would differ. Its record names who authorized it and how
 * (`PrincipalAuthorization`); the protocol signature the frozen Portfolio
 * Verifier checks is the demonstration key's either way, because a wallet
 * cannot sign that raw prehash.
 *
 * A signed version is never edited: a change is a new version whose record
 * names what it supersedes and which fields changed. Superseding revokes
 * the previous root through the ledger's own `REVOKE`, so a proposal or
 * child made under it is refused by Mandate, not by this module's say-so.
 *
 * Amendments stop once anything was reserved in the session: reservations
 * under a revoked root stay live, a new root would not see them, and Core
 * has no settlement reconciliation to carry them over. Refusing is the
 * honest option; double-counting authority is not.
 */

import type { LedgerStore, ReducerRules } from '@mandate/ledger';
import { mandateSignedByPrincipalV2, mandateSignedByPrincipalV2Plan, portfolioMandateDigest, validatePortfolioMandate, type CompiledPortfolio, type DomainBinding, type PortfolioCore, type PortfolioMandate } from '@mandate/portfolio';
import { compile, registerFirst, registerSuccessor, revokeRoot } from '../mandate/portfolio-adapter.ts';
import { PRINCIPAL_SIGNATURE_LABEL, type LocalPrincipalSigner } from '../mandate/signer.ts';
import { APPROVAL_CHAIN_ID } from '../wallet/approval.ts';
import type { Clock } from '../runtime/clock.ts';
import { draftPaths } from './draft-fields.ts';
import { fieldAt, type MandateDraft } from './draft-types.ts';
import { validateDraft, type DraftValidation, type GuardrailRow } from './draft-validator.ts';
import type { ValidationIssue } from './conflicts.ts';

export type VersionStatus = 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

export interface FieldChange {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

export const AUTHORIZATION_METHODS = ['WALLET_EIP712', 'DEMO_PRINCIPAL_KEY', 'WALLET_PRINCIPAL_V2', 'WALLET_PRINCIPAL_V2_PLAN'] as const;
export type AuthorizationMethod = (typeof AUTHORIZATION_METHODS)[number];

/** What the wallet approval bound, public facts only: the signature itself is evidence kept server-side. */
export interface WalletApprovalFacts {
  readonly chainId: string;
  readonly environment: string;
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: string };
  readonly primaryType: string;
  readonly sessionDigest: string;
  readonly challengeDigest: string;
  readonly signatureDigest: string;
  readonly validAfter: string;
  readonly validUntil: string;
  readonly initialAllocationDigest?: string;
}

/**
 * Who authorized a version, and how.
 *
 * `WALLET_EIP712` and `DEMO_PRINCIPAL_KEY` are the V1 paths: `protocolSigner`
 * is the demonstration principal key, and `domainDelegation` is
 * `NOT_DELEGATED`. `WALLET_PRINCIPAL_V2` names the wallet as both `principal`
 * and `protocolSigner`; the stored signature is that wallet's EIP-712 V2
 * signature. Domain execution is allowed only for that same address
 * (`SAME_PRINCIPAL`): it is the manifest principal, or it presents a separate
 * per-execution gate signature. It does not delegate to any other key.
 */
export interface PrincipalAuthorization {
  readonly method: AuthorizationMethod;
  readonly principal: string;
  readonly protocolSigner: string;
  readonly label: string;
  readonly wallet: WalletApprovalFacts | null;
  readonly domainDelegation: 'NOT_DELEGATED' | 'SAME_PRINCIPAL';
}

export const DEMO_AUTHORIZATION_LABEL = 'Demo principal key: the exact confirmation text, then the publicly derived demonstration key signs. Not a wallet signature.';
export const WALLET_AUTHORIZATION_LABEL = 'Wallet-signed mandate: EIP-712 approval of the exact mandate digest, verified by this server. The demonstration principal key then countersigns for the frozen Portfolio Verifier. Domain execution authority is not delegated.';
export const SPINE_AUTHORIZATION_LABEL = 'Wallet is the protocol principal: EIP-712 PortfolioMandateV2 over the canonical mandate digest. Domain execution still needs this same address to sign each gate mandate.';
export const SPINE_SIGNATURE_LABEL = 'EIP-712 PortfolioMandateV2 by the wallet principal (Robinhood Chain testnet, chain 46630). Not the demonstration key.';
export const PLAN_BOUND_SPINE_SIGNATURE_LABEL = 'EIP-712 PortfolioMandateAuthorizationV2 by the wallet principal, binding the accepted initial allocation (Robinhood Chain testnet, chain 46630).';

/** The public record of a version. No key, no core. */
export interface VersionRecord {
  readonly version: number;
  readonly status: VersionStatus;
  readonly digest: string;
  readonly policyVersion: string;
  readonly signature: string;
  readonly signatureLabel: string;
  readonly authorizedAt: string;
  readonly protocolTime: string;
  readonly expiresAt: string;
  readonly ledgerVersion: string;
  readonly supersedes: number | null;
  readonly supersededBy: number | null;
  readonly supersededAt: string | null;
  readonly revokedAtLedgerVersion: string | null;
  readonly changes: readonly FieldChange[];
  readonly guardrails: readonly GuardrailRow[];
  readonly authorization: PrincipalAuthorization;
}

/** One exact mandate, compiled and ready to authorize: what a wallet challenge binds. */
export interface PreparedVersion {
  readonly version: number;
  readonly draft: MandateDraft;
  readonly validation: DraftValidation;
  readonly mandate: PortfolioMandate;
  readonly compiled: CompiledPortfolio;
  readonly digest: string;
  readonly preparedAt: bigint;
}

/** What eligibility and an agent's authority view read: the compiled mandate, signed or (when planning) provisional. */
export type MandateView = Pick<ActiveMandate, 'version' | 'mandate' | 'compiled'>;

export interface ActiveMandate {
  readonly version: number;
  readonly mandate: PortfolioMandate;
  readonly compiled: CompiledPortfolio;
  readonly core: PortfolioCore;
  readonly signature: string;
  readonly draft: MandateDraft;
}

export const REFUSAL_CODES = [
  'CONFIRMATION_REQUIRED',
  'DRAFT_INVALID',
  'AMENDMENT_AFTER_RESERVATION',
  'MANDATE_PAUSED',
  'NO_ACTIVE_MANDATE',
  'LEDGER_REFUSED',
  'BUSY',
  'VERSION_STALE',
  'SESSION_RESTORED',
  'MANDATE_EXPIRED',
  'WALLET_ADDRESS_INVALID',
  'WALLET_CHALLENGE_UNKNOWN',
  'WALLET_CHALLENGE_EXPIRED',
  'WALLET_CHALLENGE_REUSED',
  'WALLET_CHALLENGE_STALE',
  'WALLET_CHALLENGE_LOCKED',
  'WALLET_DRAFT_CHANGED',
  'WALLET_SIGNATURE_MALFORMED',
  'WALLET_SIGNER_MISMATCH',
  'SPINE_SIGNATURE_INVALID',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type AuthorizeResult =
  | { readonly ok: true; readonly record: VersionRecord; readonly superseded: VersionRecord | null; readonly validation: DraftValidation }
  | { readonly ok: false; readonly code: RefusalCode; readonly message: string; readonly issues: readonly ValidationIssue[] };

export const PAUSE_CONFIRMATION = 'PAUSE MANDATE';

const DRAFT_PATHS = draftPaths();

const shown = (v: unknown) => (v === null || v === undefined ? 'unset' : Array.isArray(v) ? v.join(', ') || 'none' : String(v));

export function diffDrafts(a: MandateDraft, b: MandateDraft): readonly FieldChange[] {
  const out: FieldChange[] = [];
  for (const p of DRAFT_PATHS) {
    const from = shown(fieldAt(a, p));
    const to = shown(fieldAt(b, p));
    if (from !== to) out.push({ field: p, from, to });
  }
  return out;
}

interface Entry {
  record: VersionRecord;
  active: ActiveMandate;
}

/**
 * Where a durable session keeps its versions (persistence/session-store.ts).
 * Called synchronously after each in-memory change; the ledger itself is
 * durable through `storeOf`, which builds the first version's store.
 */
export interface VersionPersistence {
  readonly storeOf: (rules: ReducerRules) => LedgerStore;
  onVersion(record: VersionRecord, active: ActiveMandate): void;
  onRecord(record: VersionRecord): void;
  onFlags(flags: { readonly paused: boolean; readonly reserved: boolean }): void;
}

/** A version as a durable session restores it: its record and an active mandate rebuilt over the durable ledger. */
export interface RestoredVersion {
  readonly record: VersionRecord;
  readonly active: ActiveMandate;
}

export class MandateVersions {
  readonly #bindings: readonly DomainBinding[];
  readonly #signer: LocalPrincipalSigner;
  readonly #clock: Clock;
  readonly #entries: Entry[] = [];
  readonly #persist: VersionPersistence | null;
  #reserved = false;
  #reserving = false;
  #paused = false;
  #busy = false;

  constructor(o: { readonly bindings: readonly DomainBinding[]; readonly signer: LocalPrincipalSigner; readonly clock: Clock; readonly persist?: VersionPersistence; readonly restored?: { readonly versions: readonly RestoredVersion[]; readonly paused: boolean; readonly reserved: boolean } }) {
    this.#bindings = o.bindings;
    this.#signer = o.signer;
    this.#clock = o.clock;
    this.#persist = o.persist ?? null;
    if (o.restored !== undefined) {
      for (const v of o.restored.versions) this.#entries.push({ record: v.record, active: v.active });
      this.#paused = o.restored.paused;
      this.#reserved = o.restored.reserved;
    }
  }

  #registerFirst(compiled: CompiledPortfolio, at: bigint): ReturnType<typeof registerFirst> {
    return registerFirst(compiled, at, this.#persist?.storeOf);
  }

  get nextVersion(): number {
    return this.#entries.length + 1;
  }

  /** The exact words the principal must give to authorize the next version. */
  get expectedConfirmation(): string {
    return `AUTHORIZE MANDATE V${this.nextVersion}`;
  }

  get active(): ActiveMandate | null {
    if (this.#paused) return null;
    const last = this.#entries[this.#entries.length - 1];
    return last?.record.status === 'ACTIVE' ? last.active : null;
  }

  /** Every version ever authorized, oldest first; including superseded ones. */
  get records(): readonly VersionRecord[] {
    return this.#entries.map((e) => e.record);
  }

  /** The core of any version, active or not: the ledger is shared, and a revoked root is still there to be refused. */
  coreOf(version: number): ActiveMandate | null {
    return this.#entries[version - 1]?.active ?? null;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get reserved(): boolean {
    return this.#reserved;
  }

  /**
   * Hold the active version still while the ledger reserves under it: an
   * amendment or pause arriving meanwhile is refused as BUSY rather than
   * revoking the root halfway through a reservation. `false` if an
   * authorization is already in progress.
   */
  beginReservation(): boolean {
    if (this.#busy || this.#reserving) return false;
    this.#reserving = true;
    return true;
  }

  /** `reserved`: something was reserved; from now on authority can only be paused, not amended. */
  endReservation(reserved: boolean): void {
    this.#reserving = false;
    if (reserved) this.markReserved();
  }

  /** Something was reserved outside a held reservation (tests, continuations). */
  markReserved(): void {
    if (this.#reserved) return;
    this.#reserved = true;
    this.#persist?.onFlags({ paused: this.#paused, reserved: this.#reserved });
  }

  validate(draft: MandateDraft, protocolNow: bigint): DraftValidation {
    return validateDraft(draft, { version: this.nextVersion, protocolNow, bindings: this.#bindings });
  }

  /** Why nothing may be authorized right now, before any confirmation is read; `null` when something may. */
  #held(): { readonly code: RefusalCode; readonly message: string } | null {
    if (this.#busy) return { code: 'BUSY', message: 'Another authorization is in progress.' };
    if (this.#reserving) return { code: 'BUSY', message: 'The ledger is reserving under the active version; try again when it finishes.' };
    return null;
  }

  #closed(): { readonly code: RefusalCode; readonly message: string } | null {
    if (this.#paused) return { code: 'MANDATE_PAUSED', message: 'The mandate was paused; this session authorizes nothing further.' };
    if (this.#entries.length > 0 && this.#reserved) {
      return { code: 'AMENDMENT_AFTER_RESERVATION', message: 'Authority was already reserved under the active version. Core has no settlement reconciliation to carry those reservations to a new version, so an amendment now would double-count authority. Pause is still available.' };
    }
    return null;
  }

  /** The demonstration principal key path: the exact confirmation text, then prepare and commit. */
  async authorize(draft: MandateDraft, confirmation: string, protocolNow: bigint): Promise<AuthorizeResult> {
    const refuse = (code: RefusalCode, message: string, issues: readonly ValidationIssue[] = []): AuthorizeResult => ({ ok: false, code, message, issues });
    const held = this.#held();
    if (held !== null) return refuse(held.code, held.message);
    if (confirmation !== this.expectedConfirmation) return refuse('CONFIRMATION_REQUIRED', `Authorization needs the principal's explicit confirmation: "${this.expectedConfirmation}".`);
    const p = this.prepare(draft, protocolNow);
    if (!p.ok) return p;
    const by = this.#signer.party.value;
    return this.commit(p.prepared, { method: 'DEMO_PRINCIPAL_KEY', principal: by, protocolSigner: by, label: DEMO_AUTHORIZATION_LABEL, wallet: null, domainDelegation: 'NOT_DELEGATED' }, protocolNow);
  }

  /**
   * V1 paths: the demonstration key signs the raw prehash, and a supplied
   * signature is ignored by never being consulted — callers must not pass one.
   * V2: the wallet signature is the protocol signature. The demonstration key
   * is not used. A signature that does not recover to the mandate principal
   * for this chain and session is refused, and nothing is registered under it
   * beyond the ledger write that already happened; the caller consumes the
   * challenge first, so a refusal cannot be retried with another signature.
   */
  #protocolSignature(prepared: PreparedVersion, authorization: PrincipalAuthorization, protocolSignature: string | undefined): { readonly ok: true; readonly signature: string; readonly label: string } | { readonly ok: false; readonly code: RefusalCode; readonly message: string } {
    if (authorization.method !== 'WALLET_PRINCIPAL_V2' && authorization.method !== 'WALLET_PRINCIPAL_V2_PLAN') {
      if (protocolSignature !== undefined) return { ok: false, code: 'SPINE_SIGNATURE_INVALID', message: 'A V1 authorization is signed by the demonstration principal key. An external signature is not accepted on that path.' };
      return { ok: true, signature: this.#signer.signMandate(prepared.mandate), label: PRINCIPAL_SIGNATURE_LABEL };
    }
    const wallet = authorization.wallet;
    if (wallet === null || protocolSignature === undefined) return { ok: false, code: 'SPINE_SIGNATURE_INVALID', message: 'A V2 mandate needs the wallet’s EIP-712 signature.' };
    if (authorization.domainDelegation !== 'SAME_PRINCIPAL' || authorization.protocolSigner !== authorization.principal) {
      return { ok: false, code: 'SPINE_SIGNATURE_INVALID', message: 'V2 names one principal. The protocol signer and the domain principal are that address, or the mandate is refused.' };
    }
    if (prepared.mandate.principal.kind !== 'eip155-address' || prepared.mandate.principal.value !== authorization.principal) {
      return { ok: false, code: 'SPINE_SIGNATURE_INVALID', message: 'The compiled mandate’s principal is not the wallet that signed it.' };
    }
    if (wallet.chainId !== APPROVAL_CHAIN_ID.toString()) return { ok: false, code: 'SPINE_SIGNATURE_INVALID', message: 'V2 signatures are bound to Robinhood Chain testnet.' };
    const valid = authorization.method === 'WALLET_PRINCIPAL_V2_PLAN'
      ? wallet.initialAllocationDigest !== undefined && mandateSignedByPrincipalV2Plan(prepared.mandate, protocolSignature, { chainId: APPROVAL_CHAIN_ID, sessionDigest: wallet.sessionDigest, initialAllocationDigest: wallet.initialAllocationDigest })
      : mandateSignedByPrincipalV2(prepared.mandate, protocolSignature, { chainId: APPROVAL_CHAIN_ID, sessionDigest: wallet.sessionDigest });
    if (!valid) {
      return { ok: false, code: 'SPINE_SIGNATURE_INVALID', message: 'The signature is not this wallet’s EIP-712 signature of this mandate for this session.' };
    }
    return { ok: true, signature: protocolSignature, label: authorization.method === 'WALLET_PRINCIPAL_V2_PLAN' ? PLAN_BOUND_SPINE_SIGNATURE_LABEL : SPINE_SIGNATURE_LABEL };
  }

  /** The demonstration principal's address: the V1 protocol signer. V2 versions name the wallet instead. */
  get protocolSigner(): string {
    return this.#signer.party.value;
  }

  /**
   * Validate and compile `draft` as the next version: one exact mandate, its
   * digest fixed. Writes nothing. `principal`, when set, is the wallet the
   * V2 spine compiles into the mandate; omitted, the demonstration principal.
   */
  prepare(draft: MandateDraft, protocolNow: bigint, principal?: { readonly kind: 'eip155-address'; readonly value: string }): { readonly ok: true; readonly prepared: PreparedVersion } | Extract<AuthorizeResult, { ok: false }> {
    const refuse = (code: RefusalCode, message: string, issues: readonly ValidationIssue[] = []) => ({ ok: false as const, code, message, issues });
    const held = this.#held();
    if (held !== null) return refuse(held.code, held.message);
    const closed = this.#closed();
    if (closed !== null) return refuse(closed.code, closed.message);
    const version = this.nextVersion;
    const validation = validateDraft(draft, { version, protocolNow, bindings: this.#bindings, ...(principal === undefined ? {} : { principal }) });
    if (!validation.ok || validation.mandate === null) return refuse('DRAFT_INVALID', 'The draft has blocking issues.', validation.issues);
    const m = validatePortfolioMandate(validation.mandate);
    if (!m.ok) return refuse('DRAFT_INVALID', `Mandate refuses the draft: ${m.error.code}.`);
    const c = compile(m.value, this.#bindings);
    if (!c.ok) return refuse('DRAFT_INVALID', `Mandate refuses the draft: ${c.reasons.map((r) => r.code).join(', ')}.`);
    return { ok: true, prepared: { version, draft, validation, mandate: m.value, compiled: c.compiled, digest: portfolioMandateDigest(m.value), preparedAt: protocolNow } };
  }

  /**
   * The never-signed compilation a Planning Room analyzes under
   * (allocation/planning.ts): the draft validated in planning mode — each
   * delegated agent at its ceiling, no split yet — and compiled. It writes
   * nothing, is not checked against pause or reservations because it can
   * never be committed, and grants nothing.
   */
  provisional(draft: MandateDraft, protocolNow: bigint): { readonly ok: true; readonly mandate: MandateView; readonly validation: DraftValidation } | { readonly ok: false; readonly issues: readonly ValidationIssue[]; readonly message: string } {
    const version = this.nextVersion;
    const validation = validateDraft(draft, { version, protocolNow, bindings: this.#bindings, planning: true });
    if (!validation.ok || validation.mandate === null) return { ok: false, issues: validation.issues, message: 'The draft has blocking issues; resolve them before asking the agents for a split.' };
    const m = validatePortfolioMandate(validation.mandate);
    if (!m.ok) return { ok: false, issues: [], message: `Mandate refuses the draft: ${m.error.code}.` };
    const c = compile(m.value, this.#bindings);
    if (!c.ok) return { ok: false, issues: [], message: `Mandate refuses the draft: ${c.reasons.map((r) => r.code).join(', ')}.` };
    return { ok: true, mandate: { version, mandate: m.value, compiled: c.compiled }, validation };
  }

  /**
   * Make a prepared version ACTIVE under `authorization`. The prepared
   * mandate is registered exactly as prepared; it must still be the next
   * version and unexpired, and nothing may have been reserved or paused
   * since.
   */
  async commit(prepared: PreparedVersion, authorization: PrincipalAuthorization, protocolNow: bigint, protocolSignature?: string): Promise<AuthorizeResult> {
    const refuse = (code: RefusalCode, message: string, issues: readonly ValidationIssue[] = []): AuthorizeResult => ({ ok: false, code, message, issues });
    const held = this.#held();
    if (held !== null) return refuse(held.code, held.message);
    const closed = this.#closed();
    if (closed !== null) return refuse(closed.code, closed.message);
    if (prepared.version !== this.nextVersion) return refuse('VERSION_STALE', `This approval was for V${prepared.version}; the next version is V${this.nextVersion}.`);
    if (protocolNow >= prepared.mandate.expiresAt) return refuse('MANDATE_EXPIRED', 'The prepared mandate has already expired; prepare it again.');
    const signed = this.#protocolSignature(prepared, authorization, protocolSignature);
    if (!signed.ok) return refuse(signed.code, signed.message);
    const previous = this.#entries[this.#entries.length - 1];
    this.#busy = true;
    try {
      const version = prepared.version;
      let revokedAt: string | null = null;
      if (previous !== undefined) {
        const revoked = await revokeRoot(previous.active.core, protocolNow, BigInt(previous.record.version));
        if (!revoked.ok) return refuse('LEDGER_REFUSED', `The ledger refused to revoke V${previous.record.version}: ${revoked.reason}.`);
        revokedAt = revoked.ledgerVersion.toString();
      }
      const registered = previous === undefined ? await this.#registerFirst(prepared.compiled, protocolNow) : await registerSuccessor(previous.active.core, prepared.compiled, protocolNow);
      if (!registered.ok) {
        // V<n-1> is already revoked: fail closed with no active mandate rather than restore it.
        if (previous !== undefined) {
          previous.record = { ...previous.record, status: 'REVOKED', revokedAtLedgerVersion: revokedAt };
          this.#paused = true;
          this.#persist?.onRecord(previous.record);
          this.#persist?.onFlags({ paused: this.#paused, reserved: this.#reserved });
        }
        return refuse('LEDGER_REFUSED', `The ledger refused to register V${version}: ${registered.reasons.map((r) => r.code).join(', ')}.`);
      }
      const signature = signed.signature;
      const at = this.#clock.wallIso();
      const record: VersionRecord = {
        version,
        status: 'ACTIVE',
        digest: prepared.digest,
        policyVersion: prepared.mandate.policyVersion.toString(),
        signature,
        signatureLabel: signed.label,
        authorizedAt: at,
        protocolTime: protocolNow.toString(),
        expiresAt: prepared.mandate.expiresAt.toString(),
        ledgerVersion: registered.ledgerVersion.toString(),
        supersedes: previous === undefined ? null : previous.record.version,
        supersededBy: null,
        supersededAt: null,
        revokedAtLedgerVersion: null,
        changes: previous === undefined ? [] : diffDrafts(previous.active.draft, prepared.draft),
        guardrails: prepared.validation.guardrails,
        authorization,
      };
      let superseded: VersionRecord | null = null;
      if (previous !== undefined) {
        superseded = { ...previous.record, status: 'SUPERSEDED', supersededBy: version, supersededAt: at, revokedAtLedgerVersion: revokedAt };
        previous.record = superseded;
        this.#persist?.onRecord(superseded);
      }
      const active: ActiveMandate = { version, mandate: prepared.mandate, compiled: prepared.compiled, core: registered.core, signature, draft: prepared.draft };
      this.#entries.push({ record, active });
      this.#persist?.onVersion(record, active);
      return { ok: true, record, superseded, validation: prepared.validation };
    } finally {
      this.#busy = false;
    }
  }

  /** Revoke the active root with no successor: every later authorization is refused, by the ledger. */
  async pause(confirmation: string, protocolNow: bigint): Promise<{ readonly ok: true; readonly record: VersionRecord } | { readonly ok: false; readonly code: RefusalCode; readonly message: string }> {
    if (confirmation !== PAUSE_CONFIRMATION) return { ok: false, code: 'CONFIRMATION_REQUIRED', message: `Pausing needs the explicit confirmation "${PAUSE_CONFIRMATION}".` };
    if (this.#reserving || this.#busy) return { ok: false, code: 'BUSY', message: 'A reservation or authorization is in progress; try again when it finishes.' };
    const last = this.#entries[this.#entries.length - 1];
    if (last === undefined || last.record.status !== 'ACTIVE' || this.#paused) return { ok: false, code: 'NO_ACTIVE_MANDATE', message: 'There is no active mandate to pause.' };
    const revoked = await revokeRoot(last.active.core, protocolNow, BigInt(last.record.version));
    if (!revoked.ok) return { ok: false, code: 'LEDGER_REFUSED', message: `The ledger refused the revocation: ${revoked.reason}.` };
    last.record = { ...last.record, status: 'REVOKED', revokedAtLedgerVersion: revoked.ledgerVersion.toString() };
    this.#paused = true;
    this.#persist?.onRecord(last.record);
    this.#persist?.onFlags({ paused: this.#paused, reserved: this.#reserved });
    return { ok: true, record: last.record };
  }
}
