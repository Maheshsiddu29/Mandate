/**
 * Mandate versions (docs/demo/live-ai-lab.md §3).
 *
 * The only path from a draft to authority:
 *
 * ```text
 * authorize(draft, "AUTHORIZE MANDATE V<n>")
 *   ─▶ the confirmation is exactly the next version's ─▶ the draft validates with no blocking issue
 *   ─▶ compile ─▶ (V2+) revoke the active root in the ledger ─▶ register ─▶ principal signs ─▶ ACTIVE
 * ```
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

import { portfolioMandateDigest, validatePortfolioMandate, type CompiledPortfolio, type DomainBinding, type PortfolioCore, type PortfolioMandate } from '@mandate/portfolio';
import { compile, registerFirst, registerSuccessor, revokeRoot } from '../mandate/portfolio-adapter.ts';
import { PRINCIPAL_SIGNATURE_LABEL, type LocalPrincipalSigner } from '../mandate/signer.ts';
import type { Clock } from '../runtime/clock.ts';
import { fieldAt, type MandateDraft } from './draft-types.ts';
import { validateDraft, type DraftValidation, type GuardrailRow } from './draft-validator.ts';
import type { ValidationIssue } from './conflicts.ts';

export type VersionStatus = 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';

export interface FieldChange {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

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
}

export interface ActiveMandate {
  readonly version: number;
  readonly mandate: PortfolioMandate;
  readonly compiled: CompiledPortfolio;
  readonly core: PortfolioCore;
  readonly signature: string;
  readonly draft: MandateDraft;
}

export const REFUSAL_CODES = ['CONFIRMATION_REQUIRED', 'DRAFT_INVALID', 'AMENDMENT_AFTER_RESERVATION', 'MANDATE_PAUSED', 'NO_ACTIVE_MANDATE', 'LEDGER_REFUSED', 'BUSY'] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type AuthorizeResult =
  | { readonly ok: true; readonly record: VersionRecord; readonly superseded: VersionRecord | null; readonly validation: DraftValidation }
  | { readonly ok: false; readonly code: RefusalCode; readonly message: string; readonly issues: readonly ValidationIssue[] };

export const PAUSE_CONFIRMATION = 'PAUSE MANDATE';

const DRAFT_PATHS = [
  ...['totalCapital', 'minUnallocated', 'maxDeployed', 'deployAll', 'maxDerivative', 'maxIlliquid', 'validityMinutes'].map((f) => `portfolio.${f}`),
  ...['stock', 'swap', 'nft', 'yield', 'perps'].flatMap((r) => ['enabled', 'maxAllocation', 'maxExposure'].map((f) => `agents.${r}.${f}`)),
  ...['assets', 'issuers', 'representations', 'venues', 'chains', 'maxLeverage', 'maxSlippageBps', 'maxQuoteAgeSeconds'].map((f) => `market.${f}`),
  'execution.recipients',
];

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

export class MandateVersions {
  readonly #bindings: readonly DomainBinding[];
  readonly #signer: LocalPrincipalSigner;
  readonly #clock: Clock;
  readonly #entries: Entry[] = [];
  #reserved = false;
  #paused = false;
  #busy = false;

  constructor(o: { readonly bindings: readonly DomainBinding[]; readonly signer: LocalPrincipalSigner; readonly clock: Clock }) {
    this.#bindings = o.bindings;
    this.#signer = o.signer;
    this.#clock = o.clock;
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

  /** Something was reserved: from now on authority can only be paused, not amended. */
  markReserved(): void {
    this.#reserved = true;
  }

  validate(draft: MandateDraft, protocolNow: bigint): DraftValidation {
    return validateDraft(draft, { version: this.nextVersion, protocolNow, bindings: this.#bindings });
  }

  async authorize(draft: MandateDraft, confirmation: string, protocolNow: bigint): Promise<AuthorizeResult> {
    const refuse = (code: RefusalCode, message: string, issues: readonly ValidationIssue[] = []): AuthorizeResult => ({ ok: false, code, message, issues });
    if (this.#busy) return refuse('BUSY', 'Another authorization is in progress.');
    if (confirmation !== this.expectedConfirmation) return refuse('CONFIRMATION_REQUIRED', `Authorization needs the principal's explicit confirmation: "${this.expectedConfirmation}".`);
    if (this.#paused) return refuse('MANDATE_PAUSED', 'The mandate was paused; this session authorizes nothing further.');
    const previous = this.#entries[this.#entries.length - 1];
    if (previous !== undefined && this.#reserved) {
      return refuse('AMENDMENT_AFTER_RESERVATION', 'Authority was already reserved under the active version. Core has no settlement reconciliation to carry those reservations to a new version, so an amendment now would double-count authority. Pause is still available.');
    }
    this.#busy = true;
    try {
      const version = this.nextVersion;
      const validation = this.validate(draft, protocolNow);
      if (!validation.ok || validation.mandate === null) return refuse('DRAFT_INVALID', 'The draft has blocking issues.', validation.issues);
      const m = validatePortfolioMandate(validation.mandate);
      if (!m.ok) return refuse('DRAFT_INVALID', `Mandate refuses the draft: ${m.error.code}.`);
      const c = compile(m.value, this.#bindings);
      if (!c.ok) return refuse('DRAFT_INVALID', `Mandate refuses the draft: ${c.reasons.map((r) => r.code).join(', ')}.`);

      let revokedAt: string | null = null;
      if (previous !== undefined) {
        const revoked = await revokeRoot(previous.active.core, protocolNow, BigInt(previous.record.version));
        if (!revoked.ok) return refuse('LEDGER_REFUSED', `The ledger refused to revoke V${previous.record.version}: ${revoked.reason}.`);
        revokedAt = revoked.ledgerVersion.toString();
      }
      const registered = previous === undefined ? await registerFirst(c.compiled, protocolNow) : await registerSuccessor(previous.active.core, c.compiled, protocolNow);
      if (!registered.ok) {
        // V<n-1> is already revoked: fail closed with no active mandate rather than restore it.
        if (previous !== undefined) {
          previous.record = { ...previous.record, status: 'REVOKED', revokedAtLedgerVersion: revokedAt };
          this.#paused = true;
        }
        return refuse('LEDGER_REFUSED', `The ledger refused to register V${version}: ${registered.reasons.map((r) => r.code).join(', ')}.`);
      }
      const signature = this.#signer.signMandate(m.value);
      const at = this.#clock.wallIso();
      const record: VersionRecord = {
        version,
        status: 'ACTIVE',
        digest: portfolioMandateDigest(m.value),
        policyVersion: m.value.policyVersion.toString(),
        signature,
        signatureLabel: PRINCIPAL_SIGNATURE_LABEL,
        authorizedAt: at,
        protocolTime: protocolNow.toString(),
        expiresAt: m.value.expiresAt.toString(),
        ledgerVersion: registered.ledgerVersion.toString(),
        supersedes: previous === undefined ? null : previous.record.version,
        supersededBy: null,
        supersededAt: null,
        revokedAtLedgerVersion: null,
        changes: previous === undefined ? [] : diffDrafts(previous.active.draft, draft),
        guardrails: validation.guardrails,
      };
      let superseded: VersionRecord | null = null;
      if (previous !== undefined) {
        superseded = { ...previous.record, status: 'SUPERSEDED', supersededBy: version, supersededAt: at, revokedAtLedgerVersion: revokedAt };
        previous.record = superseded;
      }
      this.#entries.push({ record, active: { version, mandate: m.value, compiled: c.compiled, core: registered.core, signature, draft } });
      return { ok: true, record, superseded, validation };
    } finally {
      this.#busy = false;
    }
  }

  /** Revoke the active root with no successor: every later authorization is refused, by the ledger. */
  async pause(confirmation: string, protocolNow: bigint): Promise<{ readonly ok: true; readonly record: VersionRecord } | { readonly ok: false; readonly code: RefusalCode; readonly message: string }> {
    if (confirmation !== PAUSE_CONFIRMATION) return { ok: false, code: 'CONFIRMATION_REQUIRED', message: `Pausing needs the explicit confirmation "${PAUSE_CONFIRMATION}".` };
    const last = this.#entries[this.#entries.length - 1];
    if (last === undefined || last.record.status !== 'ACTIVE' || this.#paused) return { ok: false, code: 'NO_ACTIVE_MANDATE', message: 'There is no active mandate to pause.' };
    const revoked = await revokeRoot(last.active.core, protocolNow, BigInt(last.record.version));
    if (!revoked.ok) return { ok: false, code: 'LEDGER_REFUSED', message: `The ledger refused the revocation: ${revoked.reason}.` };
    last.record = { ...last.record, status: 'REVOKED', revokedAtLedgerVersion: revoked.ledgerVersion.toString() };
    this.#paused = true;
    return { ok: true, record: last.record };
  }
}
