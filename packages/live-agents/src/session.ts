/**
 * A Live AI Lab session (docs/demo/live-ai-lab.md).
 *
 * ```text
 * draft ─(wallet EIP-712 approval, or the demo key's AUTHORIZE MANDATE V1)─▶ ACTIVE
 *   ─▶ concurrent discovery ─▶ screening ─▶ resource conflict? ─▶ autonomous live Room
 *   ─▶ freshly signed proposals at the agreed sizes ─▶ runPortfolio (real Room, verifier, ledger)
 *   ─▶ stale quotes: REFRESH_REQUIRED ─▶ one fresh decision ─▶ runPortfolio again
 * ```
 *
 * The principal may authorize an amendment at any time before the first
 * reservation. It supersedes the version in force: the running epoch is
 * aborted (the Room finalizes SUPERSEDED, late replies are ignored),
 * in-flight proposals are re-screened under the new version and marked
 * REAUTHORIZE_REQUIRED, and discovery starts again under the new authority.
 * The principal never edits a Room allocation.
 */

import type { AuthorizationRecord } from '@mandate/control';
import { agentPolicyOf, amountOf, encodePortfolioMandate, portfolioMandateV2Hash, proposalDigest, verificationTranscript, type PortfolioAuthorityV2, type PortfolioMandate, type Reason, type SignedProposal, type VerificationTranscript, type VerifiedChild } from '@mandate/portfolio';
import { demoParty } from '@mandate/portfolio/demo';
import { classifyAllocation, planningPurpose } from './allocation/intent.ts';
import { runPlanning, type AllocationPlan } from './allocation/planning.ts';
import { FIXTURE_RESEARCH, type MarketResearchProvider } from './allocation/research.ts';
import { EXPOSURE_RESOURCE } from './authoring/catalog.ts';
import { NoScorer, type OpportunityScorer } from './jev/scorer.ts';
import type { TrustedCandidate } from './agents/spec.ts';
import { applyPreset, normalizeDraft, presetDraft, withField, type MandateDraft, type Preset } from './authoring/draft-types.ts';
import type { DraftValidation } from './authoring/draft-validator.ts';
import { MandateVersions, SPINE_AUTHORIZATION_LABEL, WALLET_AUTHORIZATION_LABEL, type ActiveMandate, type AuthorizeResult, type PrincipalAuthorization, type RefusalCode } from './authoring/mandate-versioning.ts';
import { interpretPrompt } from './authoring/prompt-to-draft.ts';
import { amountViews, enabledRoles } from './context.ts';
import { actionableCandidates, type EligibilityFilter } from './agents/eligibility.ts';
import { LIVE_LAB_SETTLEMENT_PROFILE, type SettlementProfile } from './agents/capability.ts';
import { discover, discoverAgent, type AgentOutcome, type DiscoveryDeps } from './discovery.ts';
import type { JevAdvisor } from './jev/advisor.ts';
import { NoopJevAdvisor } from './jev/noop-advisor.ts';
import { runPolicyStress, type PolicyStressResult, type Submission } from './policy-stress/runner.ts';
import { availabilityAt, ledgerView, runProtocol, sessionBindings, type ProtocolRun } from './mandate/portfolio-adapter.ts';
import { buildProposal, demandOf, SequenceBook } from './mandate/proposal-builder.ts';
import { LocalPrincipalSigner, createAgentSigners, type LocalAgentSigner } from './mandate/signer.ts';
import { reasonCodes, screen } from './mandate/verifier-adapter.ts';
import { DEFAULT_MAX_GENERATIONS, runLiveRoom, type RoomResult } from './room/coordinator.ts';
import { assess, conflictsOf, type Participant } from './room/negotiation.ts';
import { encodeRecord } from './persistence/codec.ts';
import { restoreState, type RestoredState } from './persistence/restore.ts';
import { SessionStore } from './persistence/session-store.ts';
import { protocolClock, realClock, restoredProtocolClock, type Clock } from './runtime/clock.ts';
import { RecordedProvider } from './runtime/recorded-provider.ts';
import type { AgentModelProvider } from './runtime/provider.ts';
import { realEntropy, type Entropy } from './runtime/entropy.ts';
import { EventLog } from './telemetry/events.ts';
import { ROLE_LABELS, usdcText, type Role } from './types.ts';
import { APPROVAL_CHAIN_ID, APPROVAL_DOMAIN, APPROVAL_ENVIRONMENT, APPROVAL_PRIMARY_TYPE, CHALLENGE_LIFETIME_SECONDS, approvalMessage, approvalTypedData, checkApproval, sessionDigest } from './wallet/approval.ts';
import { ChallengeBook, MAX_SIGNATURE_FAILURES, draftKey, type WalletChallenge } from './wallet/challenges.ts';
import { keccakHex, recoverAddress } from './wallet/eip712.ts';
import { spineAuthority, spineTypedData } from './wallet/spine.ts';

export interface SessionOptions {
  readonly provider: AgentModelProvider;
  /** Interprets prompts into drafts; defaults to `provider`. */
  readonly interpreter?: AgentModelProvider;
  readonly jev?: JevAdvisor;
  readonly clock?: Clock;
  readonly sessionId?: string;
  readonly agentTimeoutMs: number;
  readonly roomRoundTimeoutMs: number;
  readonly maxGenerations?: number;
  /** Fresh-decision cycles after a stale quote; default 1. */
  readonly maxRefreshes?: number;
  /** Tests: protocol time instead of the monotonic mapping. */
  readonly protocolNow?: () => bigint;
  /** A development chaos wrapper is in use: every event says so. */
  readonly chaos?: string | null;
  /** Randomness for wallet challenges; tests substitute a deterministic source. */
  readonly entropy?: Entropy;
  /** Make the session durable under this state directory (persistence/session-store.ts). */
  readonly stateDir?: string;
  /**
   * The principal's economic preference for this session ("prefer liquidity
   * over yield"), passed to every agent as ranking guidance. Interpreting a
   * prompt replaces it with that prompt. It authorizes nothing.
   */
  readonly intent?: string;
  /**
   * Tests only: replace the advisory candidate filter (agents/eligibility.ts),
   * to simulate one that is broken or bypassed. Mandate's screening never
   * depends on it; the default is the deterministic filter.
   */
  readonly eligibility?: EligibilityFilter;
  /**
   * The active settlement profile (agents/capability.ts): which actionable
   * candidates the configured connector can settle, known before any model
   * call. Defaults to the Live Lab profile. `null` evaluates no capability —
   * tests only, to reach Mandate with a candidate no connector settles.
   */
  readonly settlement?: SettlementProfile | null;
  /** Advisory opportunity scoring for Planning and Reallocation Rooms (Jev); default: none, and no score is invented. */
  readonly scorer?: OpportunityScorer;
  /** Evidence for opportunity analysis; default: the labelled fixtures, with every unavailable kind reported. */
  readonly research?: MarketResearchProvider;
  /** Internal: `LiveSession.restore` builds a restored session through this. */
  readonly restoredFrom?: { readonly store: SessionStore; readonly state: RestoredState; readonly by: string };
}

export interface RestoreOptions {
  /** Defaults to a provider that reports the recorded one and calls no model. */
  readonly provider?: AgentModelProvider;
  readonly clock?: Clock;
  readonly entropy?: Entropy;
  readonly agentTimeoutMs: number;
  readonly roomRoundTimeoutMs: number;
  /** Who restored it, for the SESSION_RESTORED event: the local server, a settlement command. */
  readonly by: string;
}

export type WalletChallengeResult =
  | { readonly ok: true; readonly challenge: string; readonly version: number; readonly digest: string; readonly principal: string; readonly validUntil: string; readonly typedData: { readonly [k: string]: unknown } }
  | { readonly ok: false; readonly code: RefusalCode; readonly message: string };

export type PlanResult =
  | { readonly ok: true; readonly plan: AllocationPlan }
  | { readonly ok: false; readonly code: 'SESSION_RESTORED' | 'BUSY' | 'NOTHING_TO_PLAN' | 'DRAFT_INVALID'; readonly message: string; readonly issues: readonly unknown[] };

export type ApplyPlanResult =
  | { readonly ok: true; readonly draft: MandateDraft }
  | { readonly ok: false; readonly code: 'PLAN_UNKNOWN' | 'PLAN_STALE' | 'ALLOCATION_INVALID'; readonly message: string };

/** A draft with the delegated agents' budgets unset: what a plan is computed against and compared with. */
function withoutPoolBudgets(d: MandateDraft): MandateDraft {
  let out = d;
  for (const r of classifyAllocation(d).pool) if (out.agents[r].budget !== null) out = withField(out, `agents.${r}.budget`, null, 'USER');
  return out;
}

/** The most each delegated agent could hold under a provisional mandate: its own maximum and exposure, its domain's portfolio limit, and the pool. */
function hardCapsOf(m: PortfolioMandate, pool: readonly Role[], poolAtoms: bigint): ReadonlyMap<Role, bigint> {
  const DOMAIN_LIMIT: { readonly [R in Role]?: string } = { perps: 'derivative-notional', nft: 'illiquid-notional', stock: 'spot-capital' };
  const caps = new Map<Role, bigint>();
  for (const r of pool) {
    const policy = agentPolicyOf(m, demoParty(r));
    if (policy === null) {
      caps.set(r, 0n);
      continue;
    }
    let cap = amountOf(policy.hardMaxima, 'portfolio-notional');
    const own = EXPOSURE_RESOURCE[r];
    const listed = own === null ? undefined : policy.hardMaxima.find((h) => h.resource === own);
    if (listed !== undefined && listed.atoms < cap) cap = listed.atoms;
    const domain = DOMAIN_LIMIT[r];
    if (domain !== undefined && amountOf(m.limits, domain) < cap) cap = amountOf(m.limits, domain);
    caps.set(r, cap < poolAtoms ? cap : poolAtoms);
  }
  return caps;
}

export type RunStatus = 'AUTHORIZED' | 'PARTIALLY_AUTHORIZED' | 'REFUSED' | 'NO_FEASIBLE_PORTFOLIO' | 'NOTHING_TO_AUTHORIZE' | 'NO_ACTIVE_MANDATE' | 'SUPERSEDED_TOO_OFTEN';

export interface FinalProposal {
  readonly role: Role;
  readonly proposal: string;
  readonly requested: bigint;
  readonly outcome: 'RESERVED' | 'REFUSED' | 'STALE';
  readonly reasons: readonly string[];
}

/**
 * A child the real Mandate path verified and reserved, exactly as it
 * returned it: the signed proposal, the verifier's child, the ledger's
 * authorization record and the transcript the verifier re-derives. What a
 * domain executor downstream may act on — and only on this object, never on
 * a reconstruction of it. Holds no key and grants nothing by itself: the
 * ledger's reservation does, and it stays checkable against the ledger.
 */
export interface ReservedExecution {
  readonly role: Role;
  /** The mandate version it was reserved under. */
  readonly version: number;
  readonly phase: 'FINAL' | 'REFRESH';
  /** The trusted candidate id the model chose (a closed-set id, never a value). */
  readonly candidateId: string;
  readonly signed: SignedProposal;
  readonly verified: VerifiedChild;
  readonly record: AuthorizationRecord;
  readonly transcript: VerificationTranscript;
  readonly receiptDigest: string;
  /** Protocol time of the reservation. */
  readonly reservedAt: bigint;
}

export interface RunResult {
  readonly status: RunStatus;
  readonly version: number | null;
  readonly epochs: number;
  readonly discovery: readonly AgentOutcome[];
  readonly room: RoomResult | null;
  readonly final: readonly FinalProposal[];
  readonly refreshed: readonly FinalProposal[];
  readonly receipts: readonly string[];
  readonly reservedAtoms: bigint;
  readonly executorCalls: number;
  readonly transactions: number;
}

const MAX_EPOCHS = 3;

/** Bytes as 0x-prefixed lowercase hex. */
const hexOf = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

export class LiveSession {
  readonly id: string;
  /** The durable store, when the session is durable. */
  readonly store: SessionStore | null;
  /** Restored from disk: evidence only — no agent runs, no new authorization. */
  readonly restored: boolean;
  /** Ledger reservations a restored session found no recorded execution for: never settled. */
  readonly orphans: readonly string[];
  readonly clock: Clock;
  readonly events: EventLog;
  readonly versions: MandateVersions;
  readonly provider: AgentModelProvider;
  readonly signers: ReadonlyMap<Role, LocalAgentSigner>;
  readonly protocolNow: () => bigint;
  readonly #o: SessionOptions;
  readonly #sequences = new SequenceBook();
  readonly #jev: JevAdvisor;
  readonly #drains: (() => Promise<void>)[] = [];
  readonly #reserved: ReservedExecution[] = [];
  readonly #entropy: Entropy;
  readonly challenges: ChallengeBook;
  readonly #approvals = new Map<number, { readonly message: ReturnType<typeof approvalMessage>; readonly signature: string }>();
  #onApproval: ((version: number, message: ReturnType<typeof approvalMessage>, signature: string) => void) | null = null;
  #epoch = new AbortController();
  #running = false;
  #intent: string | null = null;
  #rooms = 0;
  readonly #plans = new Map<string, AllocationPlan>();

  constructor(o: SessionOptions) {
    this.#o = o;
    this.clock = o.clock ?? realClock;
    this.provider = o.provider;
    this.#entropy = o.entropy ?? realEntropy;
    this.#jev = o.jev ?? new NoopJevAdvisor();
    const bindings = sessionBindings();
    const restoring = o.restoredFrom;
    let elapsedMs: (() => number) | undefined;
    if (restoring !== undefined) {
      const meta = restoring.store.meta;
      this.id = meta.sessionId;
      this.store = restoring.store;
      this.restored = true;
      this.orphans = restoring.state.orphans;
      this.protocolNow = restoredProtocolClock(this.clock, meta.protocolAnchor, meta.startWallMs, restoring.state.protocolFloor);
      elapsedMs = () => this.clock.wallMs() - meta.startWallMs;
      this.#reserved.push(...restoring.state.reservedExecutions);
      for (const [v, a] of restoring.state.approvals) this.#approvals.set(v, a);
    } else {
      this.id = o.sessionId ?? `live-${this.clock.wallIso().replace(/\D/g, '').slice(0, 17)}`;
      this.restored = false;
      this.orphans = [];
      const start = this.clock.nowMs();
      this.protocolNow = o.protocolNow ?? protocolClock(this.clock, start);
      this.store =
        o.stateDir === undefined
          ? null
          : SessionStore.create(o.stateDir, { sessionId: this.id, createdAt: this.clock.wallIso(), startWallMs: this.clock.wallMs(), protocolAnchor: this.protocolNow(), provider: { name: o.provider.name, kind: o.provider.kind, model: o.provider.model }, chaos: o.chaos ?? null });
      elapsedMs = () => this.clock.nowMs() - start;
    }
    const store = this.store;
    this.versions = new MandateVersions({
      bindings,
      signer: new LocalPrincipalSigner(),
      clock: this.clock,
      ...(store === null
        ? {}
        : {
            persist: {
              storeOf: store.ledgerStoreOf,
              onVersion: (record, active) => store.putVersion({ version: record.version, mandateHex: hexOf(encodePortfolioMandate(active.mandate)), signature: active.signature, draft: JSON.stringify(active.draft), record: encodeRecord(record) }),
              onRecord: (record) => store.putRecord(record.version, encodeRecord(record)),
              onFlags: (flags) => store.putFlags(flags),
            },
          }),
      ...(restoring === undefined ? {} : { restored: { versions: restoring.state.versions, paused: restoring.state.paused, reserved: restoring.state.reserved } }),
    });
    // Challenges are kept as evidence; a restored session authorizes nothing, so none is restored as usable.
    this.challenges = new ChallengeBook(store === null ? {} : { persist: { onChallenge: (c) => store.putChallenge(c.id, encodeRecord({ id: c.id, version: c.prepared.version, digest: c.prepared.digest, principal: c.message?.principal ?? c.prepared.mandate.principal.value, validUntil: c.message?.validUntil ?? c.deadline, failures: c.failures, consumed: c.consumed })) } });
    if (store !== null) this.#onApproval = (version, message, signature) => store.putApproval(version, encodeRecord(message), signature);
    this.signers = createAgentSigners();
    this.events = new EventLog({ sessionId: this.id, clock: this.clock, startMs: this.clock.nowMs(), elapsedMs, protocolNow: this.protocolNow, version: () => this.versions.active?.version ?? null, ...(store === null ? {} : { sink: store }) });
    if (restoring !== undefined) {
      this.events.emit('SESSION_RESTORED', {
        data: {
          by: restoring.by,
          versions: this.versions.records.map((r) => ({ version: r.version, status: r.status, digest: r.digest, method: r.authorization.method })),
          reservedExecutions: this.#reserved.length,
          orphanedReservations: this.orphans,
          paused: this.versions.paused,
          note: 'Restored from durable records. Restoring restores evidence, never authority: this session runs no agents and authorizes nothing new; the ledger decides what is still reserved.',
        },
      });
      return;
    }
    this.events.emit('SESSION_STARTED', {
      data: {
        provider: o.provider.name,
        providerKind: o.provider.kind,
        model: o.provider.model,
        jev: this.#jev.name,
        agentTimeoutMs: o.agentTimeoutMs,
        roomRoundTimeoutMs: o.roomRoundTimeoutMs,
        maxGenerations: o.maxGenerations ?? DEFAULT_MAX_GENERATIONS,
        chaos: o.chaos ?? null,
        protocolTimeAnchor: this.protocolNow(),
        durable: store !== null,
        evidence: 'Fixture markets (Phase 7F demonstration); real Mandate code; no transaction; demonstration keys only.',
      },
    });
  }

  /** Restore a durable session from `stateDir`. Corrupt or unknown records fail closed (SessionStoreCorruption). */
  static async restore(stateDir: string, sessionId: string, o: RestoreOptions): Promise<LiveSession> {
    const store = SessionStore.open(stateDir, sessionId);
    try {
      const state = await restoreState(store, sessionBindings());
      return new LiveSession({
        provider: o.provider ?? new RecordedProvider(store.meta.provider),
        ...(o.clock === undefined ? {} : { clock: o.clock }),
        ...(o.entropy === undefined ? {} : { entropy: o.entropy }),
        agentTimeoutMs: o.agentTimeoutMs,
        roomRoundTimeoutMs: o.roomRoundTimeoutMs,
        chaos: store.meta.chaos,
        restoredFrom: { store, state, by: o.by },
      });
    } catch (e) {
      store.close();
      throw e;
    }
  }

  /** The draft the server last held for this session, if durable. */
  get recordedDraft(): MandateDraft | null {
    if (this.store === null) return null;
    try {
      const d = JSON.parse(this.store.draft()) as MandateDraft | null;
      return d === null ? null : normalizeDraft(d);
    } catch {
      return null;
    }
  }

  /** Remember the server's current draft durably (the wallet path compares against it). */
  rememberDraft(d: MandateDraft | null): void {
    this.store?.putDraft(JSON.stringify(d));
  }

  close(): void {
    this.store?.close();
  }

  // --- Authoring --------------------------------------------------------------------------

  presetDraft(p: Preset): MandateDraft {
    return presetDraft(p);
  }

  fillUnset(d: MandateDraft, p: Preset): { readonly draft: MandateDraft; readonly filled: readonly string[] } {
    return applyPreset(d, p, true);
  }

  validate(d: MandateDraft): DraftValidation {
    return this.versions.validate(d, this.protocolNow());
  }

  async interpret(prompt: string): Promise<{ readonly draft: MandateDraft | null; readonly validation: DraftValidation | null; readonly error: string | null }> {
    // The principal's own words are also their preference for how agents rank what the mandate allows.
    this.#intent = prompt;
    const interpreter = this.#o.interpreter ?? this.provider;
    this.events.emit('MANDATE_DRAFT_REQUESTED', { data: { prompt: prompt.slice(0, 600), interpreter: interpreter.name, interpreterKind: interpreter.kind, model: interpreter.model } });
    const r = await interpretPrompt(prompt, interpreter, this.clock, this.#o.agentTimeoutMs);
    if (r.draft === null) {
      const error = 'error' in r.outcome ? r.outcome.error : 'no draft';
      this.events.emit('MANDATE_DRAFT_CREATED', { data: { ok: false, status: r.outcome.status, error, authority: 'NONE' } });
      return { draft: null, validation: null, error };
    }
    const validation = this.validate(r.draft);
    this.events.emit('MANDATE_DRAFT_CREATED', {
      data: { ok: true, authority: 'NONE — a draft until the principal authorizes it', fieldsSet: Object.keys(r.draft.provenance).length, issues: r.draft.issues, notes: r.draft.notes, providerLatencyMs: r.outcome.timing.providerLatencyMs },
    });
    const conflicts = validation.issues.filter((i) => i.severity === 'BLOCKING' && i.code !== 'MISSING_VALUE');
    if (conflicts.length > 0) this.events.emit('MANDATE_DRAFT_CONFLICT', { data: { issues: conflicts.map((i) => ({ code: i.code, field: i.field, message: i.message, protocol: i.protocol })) } });
    return { draft: r.draft, validation, error: null };
  }

  /**
   * Authorize V1, or an amendment, with the demonstration principal key. Only
   * `confirmation` === "AUTHORIZE MANDATE V<n>" does anything. An amendment
   * supersedes the running epoch.
   */
  async authorize(draft: MandateDraft, confirmation: string): Promise<AuthorizeResult> {
    if (this.restored) return { ok: false, code: 'SESSION_RESTORED', message: 'A restored session authorizes nothing new. Start a new session.', issues: [] };
    const amending = this.versions.active !== null;
    if (amending) this.events.emit('MANDATE_AMENDMENT_STARTED', { data: { from: this.versions.active?.version ?? null, to: this.versions.nextVersion } });
    return this.#authorized(await this.versions.authorize(draft, confirmation, this.protocolNow()), amending);
  }

  /**
   * Issue a one-time challenge for the principal's wallet to sign: the
   * exact mandate `draft` compiles to now, bound to this session, the next
   * version and `address`. Nothing is authorized until a signature over it
   * verifies (`authorizeWithWallet`).
   */
  walletChallenge(draft: MandateDraft, address: string): WalletChallengeResult {
    if (this.restored) return { ok: false, code: 'SESSION_RESTORED', message: 'A restored session authorizes nothing new. Start a new session.' };
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, code: 'WALLET_ADDRESS_INVALID', message: 'The wallet address must be a 0x-prefixed 20-byte hex address.' };
    const p = this.versions.prepare(draft, this.protocolNow());
    if (!p.ok) return { ok: false, code: p.code, message: p.message };
    const id = this.#entropy.bytes32();
    const message = approvalMessage({ mandate: p.prepared.mandate, version: p.prepared.version, principal: address.toLowerCase(), protocolSigner: this.versions.protocolSigner, validAfter: BigInt(Math.floor(this.clock.wallMs() / 1000)), sessionId: this.id, challenge: id });
    this.challenges.issue({ id, sessionId: this.id, prepared: p.prepared, spine: 'V1', message, issuedAt: message.validAfter, deadline: message.validUntil, draftKey: draftKey(draft), failures: 0, consumed: false });
    this.events.emit('MANDATE_WALLET_CHALLENGE_ISSUED', {
      data: { version: p.prepared.version, digest: p.prepared.digest, principal: message.principal, method: 'WALLET_EIP712', chainId: APPROVAL_CHAIN_ID, validUntil: message.validUntil, authority: 'NONE until the wallet signature verifies', note: 'An offchain EIP-712 signature: not a blockchain transaction.' },
    });
    return { ok: true, challenge: id, version: p.prepared.version, digest: p.prepared.digest, principal: message.principal, validUntil: message.validUntil.toString(), typedData: approvalTypedData(message) };
  }

  /**
   * V2 challenge: the compiled mandate's principal is `address`, and the
   * typed data is the protocol signature itself. Nothing is authorized until
   * `authorizeWithWallet` recovers that address.
   */
  spineChallenge(draft: MandateDraft, address: string): WalletChallengeResult {
    if (this.restored) return { ok: false, code: 'SESSION_RESTORED', message: 'A restored session authorizes nothing new. Start a new session.' };
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, code: 'WALLET_ADDRESS_INVALID', message: 'The wallet address must be a 0x-prefixed 20-byte hex address.' };
    const principal = address.toLowerCase();
    const p = this.versions.prepare(draft, this.protocolNow(), { kind: 'eip155-address', value: principal });
    if (!p.ok) return { ok: false, code: p.code, message: p.message };
    if (p.prepared.mandate.principal.value !== principal) return { ok: false, code: 'WALLET_ADDRESS_INVALID', message: 'The mandate principal is not the wallet address.' };
    const id = this.#entropy.bytes32();
    const issuedAt = BigInt(Math.floor(this.clock.wallMs() / 1000));
    const deadline = issuedAt + CHALLENGE_LIFETIME_SECONDS;
    this.challenges.issue({ id, sessionId: this.id, prepared: p.prepared, spine: 'V2', message: null, issuedAt, deadline, draftKey: draftKey(draft), failures: 0, consumed: false });
    this.events.emit('MANDATE_WALLET_CHALLENGE_ISSUED', {
      data: {
        version: p.prepared.version,
        digest: p.prepared.digest,
        principal,
        method: 'WALLET_PRINCIPAL_V2',
        chainId: APPROVAL_CHAIN_ID,
        validUntil: deadline,
        authority: 'NONE until the wallet signature verifies',
        note: 'EIP-712 PortfolioMandateV2. The wallet is the protocol principal. Not a blockchain transaction. Each gate execution still needs a separate signature by this same address.',
      },
    });
    return { ok: true, challenge: id, version: p.prepared.version, digest: p.prepared.digest, principal, validUntil: deadline.toString(), typedData: spineTypedData(p.prepared.mandate, this.id) };
  }

  /**
   * Authorize the version a wallet challenge bound, if `signature` is the
   * challenge's principal's EIP-712 signature over the approval the server
   * rebuilds from its own state. The browser supplies only the challenge id
   * and the signature.
   */
  async authorizeWithWallet(draft: MandateDraft, challengeId: string, signature: string): Promise<AuthorizeResult> {
    const refuse = (code: RefusalCode, message: string): AuthorizeResult => {
      this.events.emit('MANDATE_WALLET_APPROVAL_REFUSED', { data: { code, message } });
      return { ok: false, code, message, issues: [] };
    };
    if (this.restored) return refuse('SESSION_RESTORED', 'A restored session authorizes nothing new. Start a new session.');
    const c: WalletChallenge | null = typeof challengeId === 'string' ? this.challenges.get(challengeId) : null;
    if (c === null || c.sessionId !== this.id) return refuse('WALLET_CHALLENGE_UNKNOWN', 'No such wallet challenge in this session. Request a new one.');
    if (c.consumed) return refuse('WALLET_CHALLENGE_REUSED', 'This wallet challenge was already used. Request a new one.');
    if (c.failures >= MAX_SIGNATURE_FAILURES) return refuse('WALLET_CHALLENGE_LOCKED', 'Too many invalid signatures for this challenge. Request a new one.');
    const wallNow = BigInt(Math.floor(this.clock.wallMs() / 1000));
    if (wallNow < c.issuedAt || wallNow >= c.deadline) return refuse('WALLET_CHALLENGE_EXPIRED', 'This wallet challenge has expired. Request a new one.');
    if (c.prepared.version !== this.versions.nextVersion) return refuse('WALLET_CHALLENGE_STALE', `This challenge was for V${c.prepared.version}; the next version is V${this.versions.nextVersion}.`);
    if (draftKey(draft) !== c.draftKey) return refuse('WALLET_DRAFT_CHANGED', 'The draft changed after the challenge was issued. Review it and sign again.');
    if (c.spine === 'V2') return this.#authorizeSpine(c, signature, refuse);
    if (c.message === null) return refuse('WALLET_CHALLENGE_UNKNOWN', 'This challenge has no V1 approval to rebuild.');
    // Rebuilt from server state: the mandate prepared at issue, this session, the stored address and challenge.
    const rebuilt = approvalMessage({ mandate: c.prepared.mandate, version: c.prepared.version, principal: c.message.principal, protocolSigner: this.versions.protocolSigner, validAfter: c.message.validAfter, sessionId: this.id, challenge: c.id });
    const check = typeof signature === 'string' ? checkApproval(rebuilt, signature) : ({ ok: false, code: 'WALLET_SIGNATURE_MALFORMED' } as const);
    if (!check.ok) {
      this.challenges.failed(c.id);
      return refuse(check.code, check.code === 'WALLET_SIGNER_MISMATCH' ? 'The signature does not recover to the wallet this challenge was issued for, over exactly this mandate, session, chain and challenge.' : 'The signature is not a well-formed 65-byte ECDSA signature.');
    }
    // Consumed before anything is committed: a challenge authorizes at most once, even if the commit fails.
    this.challenges.consume(c.id);
    const authorization: PrincipalAuthorization = {
      method: 'WALLET_EIP712',
      principal: rebuilt.principal,
      protocolSigner: this.versions.protocolSigner,
      label: WALLET_AUTHORIZATION_LABEL,
      wallet: {
        chainId: APPROVAL_CHAIN_ID.toString(),
        environment: APPROVAL_ENVIRONMENT,
        domain: { name: APPROVAL_DOMAIN.name, version: APPROVAL_DOMAIN.version, chainId: APPROVAL_DOMAIN.chainId.toString() },
        primaryType: APPROVAL_PRIMARY_TYPE,
        sessionDigest: rebuilt.sessionDigest,
        challengeDigest: keccakHex(c.id),
        signatureDigest: keccakHex(check.signature),
        validAfter: rebuilt.validAfter.toString(),
        validUntil: rebuilt.validUntil.toString(),
      },
      domainDelegation: 'NOT_DELEGATED',
    };
    this.#approvals.set(c.prepared.version, { message: rebuilt, signature: check.signature });
    this.#onApproval?.(c.prepared.version, rebuilt, check.signature);
    const amending = this.versions.active !== null;
    if (amending) this.events.emit('MANDATE_AMENDMENT_STARTED', { data: { from: this.versions.active?.version ?? null, to: this.versions.nextVersion } });
    return this.#authorized(await this.versions.commit(c.prepared, authorization, this.protocolNow()), amending);
  }

  /** V2: the wallet signature is checked again, the challenge is consumed, and the demonstration key does not sign. */
  async #authorizeSpine(c: WalletChallenge, signature: string, refuse: (code: RefusalCode, message: string) => AuthorizeResult): Promise<AuthorizeResult> {
    const principal = c.prepared.mandate.principal.value;
    const bound = spineAuthority(this.id);
    let hash: Uint8Array;
    try {
      hash = portfolioMandateV2Hash(c.prepared.mandate, bound);
    } catch {
      return refuse('SPINE_SIGNATURE_INVALID', 'This mandate cannot be signed as a V2 principal authorization.');
    }
    const recovered = typeof signature === 'string' ? recoverAddress(hash, signature) : ({ ok: false, reason: 'SIGNATURE_MALFORMED' } as const);
    if (!recovered.ok) {
      this.challenges.failed(c.id);
      return refuse('WALLET_SIGNATURE_MALFORMED', 'The signature is not a well-formed 65-byte ECDSA signature.');
    }
    if (recovered.address !== principal) {
      this.challenges.failed(c.id);
      return refuse('WALLET_SIGNER_MISMATCH', 'The signature does not recover to the wallet this mandate names as protocol principal.');
    }
    this.challenges.consume(c.id);
    const authorization: PrincipalAuthorization = {
      method: 'WALLET_PRINCIPAL_V2',
      principal,
      protocolSigner: principal,
      label: SPINE_AUTHORIZATION_LABEL,
      wallet: {
        chainId: APPROVAL_CHAIN_ID.toString(),
        environment: APPROVAL_ENVIRONMENT,
        domain: { name: 'Mandate', version: '2', chainId: APPROVAL_CHAIN_ID.toString() },
        primaryType: 'PortfolioMandateV2',
        sessionDigest: bound.sessionDigest,
        challengeDigest: keccakHex(c.id),
        signatureDigest: keccakHex(recovered.normalized),
        validAfter: c.issuedAt.toString(),
        validUntil: c.deadline.toString(),
      },
      domainDelegation: 'SAME_PRINCIPAL',
    };
    const amending = this.versions.active !== null;
    if (amending) this.events.emit('MANDATE_AMENDMENT_STARTED', { data: { from: this.versions.active?.version ?? null, to: this.versions.nextVersion } });
    return this.#authorized(await this.versions.commit(c.prepared, authorization, this.protocolNow(), recovered.normalized), amending);
  }

  /** The authority the room must use for this version. Omitted means the V1 prehash check. */
  #authority(version: number): PortfolioAuthorityV2 | undefined {
    const record = this.versions.records.find((r) => r.version === version);
    if (record?.authorization.method !== 'WALLET_PRINCIPAL_V2') return undefined;
    return spineAuthority(this.id);
  }

  /**
   * Re-verify a wallet-approved version from its durable evidence: the stored
   * signature must still recover to the recorded principal over the stored
   * message, and the message must bind this session and that version's
   * digest. What a settlement command checks before it acts on the version.
   */
  verifyWalletApproval(version: number): { readonly ok: true; readonly principal: string } | { readonly ok: false; readonly reason: string } {
    const record = this.versions.records.find((r) => r.version === version);
    if (record === undefined) return { ok: false, reason: 'VERSION_UNKNOWN' };
    if (record.authorization.method !== 'WALLET_EIP712') return { ok: false, reason: 'NOT_WALLET_APPROVED' };
    const a = this.#approvals.get(version);
    if (a === undefined) return { ok: false, reason: 'APPROVAL_EVIDENCE_MISSING' };
    if (a.message.mandateDigest !== record.digest || a.message.mandateVersion !== BigInt(version) || a.message.principal !== record.authorization.principal || a.message.sessionDigest !== sessionDigest(this.id)) return { ok: false, reason: 'APPROVAL_NOT_FOR_THIS_VERSION' };
    const check = checkApproval(a.message, a.signature);
    if (!check.ok) return { ok: false, reason: check.code };
    if (keccakHex(check.signature) !== record.authorization.wallet?.signatureDigest) return { ok: false, reason: 'SIGNATURE_DIGEST_MISMATCH' };
    return { ok: true, principal: a.message.principal };
  }

  /** The wallet approval evidence (message and signature) for a version, if it was wallet-approved. Never sent to the browser. */
  walletApproval(version: number): { readonly message: ReturnType<typeof approvalMessage>; readonly signature: string } | null {
    return this.#approvals.get(version) ?? null;
  }

  #authorized(r: AuthorizeResult, amending: boolean): AuthorizeResult {
    if (!r.ok) {
      if (amending) this.events.emit('MANDATE_AMENDMENT_REFUSED', { data: { code: r.code, message: r.message, issues: r.issues.map((i) => i.code) } });
      else if (r.issues.length > 0) this.events.emit('MANDATE_DRAFT_CONFLICT', { data: { code: r.code, issues: r.issues.map((i) => ({ code: i.code, field: i.field, message: i.message, protocol: i.protocol })) } });
      return r;
    }
    const a = r.record.authorization;
    this.events.emit('MANDATE_VERSION_AUTHORIZED', {
      mandateVersion: r.record.version,
      data: {
        version: r.record.version,
        digest: r.record.digest,
        signatureLabel: r.record.signatureLabel,
        authorization: { method: a.method, principal: a.principal, protocolSigner: a.protocolSigner, label: a.label, domainDelegation: a.domainDelegation, chainId: a.wallet?.chainId ?? null, signatureDigest: a.wallet?.signatureDigest ?? null },
        supersedes: r.record.supersedes,
        changes: r.record.changes,
        guardrails: r.record.guardrails,
        ledgerVersion: r.record.ledgerVersion,
        expiresAt: r.record.expiresAt,
      },
    });
    if (r.superseded !== null) {
      this.events.emit('MANDATE_VERSION_SUPERSEDED', { mandateVersion: r.superseded.version, data: { version: r.superseded.version, supersededBy: r.record.version, revokedAtLedgerVersion: r.superseded.revokedAtLedgerVersion, effect: 'root revoked in the ledger: nothing further is authorized under it' } });
      this.events.emit('MANDATE_AMENDMENT_AUTHORIZED', { data: { from: r.superseded.version, to: r.record.version, changes: r.record.changes, effect: 'in-flight proposals must be re-authorized; negotiation restarts under the new version' } });
      this.#epoch.abort();
    }
    return r;
  }

  async pause(confirmation: string): Promise<boolean> {
    const r = await this.versions.pause(confirmation, this.protocolNow());
    if (r.ok) {
      this.events.emit('MANDATE_PAUSED', { mandateVersion: r.record.version, data: { version: r.record.version, revokedAtLedgerVersion: r.record.revokedAtLedgerVersion } });
      this.#epoch.abort();
    }
    return r.ok;
  }

  // --- Planning (pre-authorization) ---------------------------------------------------------

  /**
   * The Planning Room (docs/v2/mandate-room-v2.md §5): the agents the
   * principal left the split to analyze their opportunities, and the
   * deterministic allocator proposes budgets for the pool. Advisory: it signs
   * nothing and writes no ledger entry; the principal reviews, may edit, and
   * signs once.
   */
  async plan(draft: MandateDraft): Promise<PlanResult> {
    if (this.restored) return { ok: false, code: 'SESSION_RESTORED', message: 'A restored session plans nothing. Start a new session.', issues: [] };
    if (this.#running) return { ok: false, code: 'BUSY', message: 'A run is in progress.', issues: [] };
    const base = withoutPoolBudgets(draft);
    const v = classifyAllocation(base);
    const purpose = planningPurpose(v);
    if (purpose === null || v.pool.length === 0 || v.poolAtoms === null) return { ok: false, code: 'NOTHING_TO_PLAN', message: v.intent === 'NEEDS_AGENT_SELECTION' ? 'Choose which agents may use this capital first.' : 'You set every budget yourself: there is no split to propose.', issues: [] };
    const provisional = this.versions.provisional(base, this.protocolNow());
    if (!provisional.ok) return { ok: false, code: 'DRAFT_INVALID', message: provisional.message, issues: provisional.issues };
    this.#running = true;
    try {
      this.#rooms += 1;
      const roomId = `plan-${this.versions.nextVersion}-${this.#rooms}`;
      const plan = await runPlanning(this.#planningDeps(), {
        roomId,
        purpose,
        provisional: provisional.mandate,
        pool: v.pool,
        poolAtoms: v.poolAtoms,
        fixed: v.fixed.map((r) => ({ role: r, atoms: v.budgets[r] as bigint })),
        hardCaps: hardCapsOf(provisional.mandate.mandate, v.pool, v.poolAtoms),
        draftKey: draftKey(base),
      });
      this.#plans.set(roomId, plan);
      return { ok: true, plan };
    } finally {
      this.#running = false;
    }
  }

  #planningDeps() {
    return { provider: this.provider, scorer: this.#o.scorer ?? new NoScorer(), research: this.#o.research ?? FIXTURE_RESEARCH, clock: this.clock, events: this.events, protocolNow: this.protocolNow, timeoutMs: this.#o.agentTimeoutMs, ...(this.#o.eligibility === undefined ? {} : { eligibility: this.#o.eligibility }), settlement: this.#o.settlement === undefined ? LIVE_LAB_SETTLEMENT_PROFILE : this.#o.settlement, intent: this.#intent ?? this.#o.intent ?? null };
  }

  /** A plan this session proposed, by its Room id. */
  planOf(roomId: string): AllocationPlan | null {
    return this.#plans.get(roomId) ?? null;
  }

  /**
   * Write a plan's budgets into the draft, with the principal's edits on top.
   * A budget equal to the plan's is `PLANNED`; an edited one is the
   * principal's own (`USER`). Refused if the draft changed since the plan
   * was computed (other than these budgets) or the plan's evidence is stale.
   * The result is only a draft: validation and the signature still decide.
   */
  applyPlan(draft: MandateDraft, roomId: string, edits: { readonly [R in Role]?: string } = {}): ApplyPlanResult {
    const plan = this.#plans.get(roomId);
    if (plan === undefined) return { ok: false, code: 'PLAN_UNKNOWN', message: 'No such plan in this session. Ask the agents for a split again.' };
    if (draftKey(withoutPoolBudgets(draft)) !== plan.draftKey) return { ok: false, code: 'PLAN_STALE', message: 'The draft changed after this split was proposed. Ask the agents again.' };
    if (this.protocolNow() > plan.freshUntil) return { ok: false, code: 'PLAN_STALE', message: 'The market observations behind this split are stale. Ask the agents again.' };
    let out = draft;
    for (const a of plan.allocations) {
      const edit = edits[a.role];
      const planned = usdcText(a.atoms);
      out = withField(out, `agents.${a.role}.budget`, edit ?? planned, edit === undefined || edit === planned ? 'PLANNED' : 'USER');
    }
    for (const [role, value] of Object.entries(edits) as [Role, string][]) {
      if (plan.allocations.some((a) => a.role === role)) continue;
      if (out.agents[role].enabled !== true) return { ok: false, code: 'ALLOCATION_INVALID', message: `The ${ROLE_LABELS[role]} is not enabled: it can be given no budget.` };
      out = withField(out, `agents.${role}.budget`, value, 'USER');
    }
    this.events.emit('ALLOCATION_PLAN_APPLIED', {
      roomId,
      mandateVersion: null,
      data: {
        budgets: classifyAllocation(out).enabled.map((r) => ({ role: r, budget: out.agents[r].budget, source: out.provenance[`agents.${r}.budget`] ?? null })),
        edited: (Object.keys(edits) as Role[]).filter((r) => out.provenance[`agents.${r}.budget`] === 'USER'),
        authority: 'NONE — a draft until you sign it',
      },
    });
    return { ok: true, draft: out };
  }

  // --- Autonomous operation ----------------------------------------------------------------

  /** Every child the real Mandate path reserved in this session, in reservation order. */
  get reservedExecutions(): readonly ReservedExecution[] {
    return this.#reserved;
  }

  #deps(): DiscoveryDeps {
    return { provider: this.provider, jev: this.#jev, clock: this.clock, events: this.events, signers: this.signers, sequences: this.#sequences, protocolNow: this.protocolNow, timeoutMs: this.#o.agentTimeoutMs, current: () => this.versions.active, eligibility: this.#o.eligibility ?? actionableCandidates, settlement: this.#o.settlement === undefined ? LIVE_LAB_SETTLEMENT_PROFILE : this.#o.settlement, intent: this.#intent ?? this.#o.intent ?? null };
  }

  /** Everything superseded is re-screened under the version now in force: Mandate refuses the old digest. */
  #markSuperseded(outcomes: readonly AgentOutcome[]): void {
    const now = this.versions.active;
    for (const o of outcomes) {
      if (o.signed === null || o.state === 'STALE' || o.state === 'BLOCKED') continue;
      const s = now === null ? null : screen(now.mandate, now.compiled.bindings, o.signed, this.protocolNow());
      this.events.emit('PROPOSAL_STALE', { agent: o.role, mandateVersion: o.version, data: { cause: now === null ? 'MANDATE_PAUSED' : 'MANDATE_SUPERSEDED', askedUnder: o.version, screenedUnder: now?.version ?? null, reasons: s === null ? [] : reasonCodes(s.reasons), next: 'REAUTHORIZE_REQUIRED' } });
    }
  }

  async run(): Promise<RunResult> {
    if (this.#running) throw new Error('this session is already running');
    if (this.restored) throw new Error('a restored session runs no agents');
    this.#running = true;
    try {
      for (let epoch = 1; epoch <= MAX_EPOCHS; epoch += 1) {
        const active = this.versions.active;
        if (active === null) return this.#result('NO_ACTIVE_MANDATE', null, epoch, [], null);
        this.#epoch = new AbortController();
        const signal = this.#epoch.signal;
        const outcomes = await discover(this.#deps(), active, enabledRoles(active));
        if (signal.aborted) {
          this.#markSuperseded(outcomes);
          continue;
        }
        const admissible = outcomes.filter((o) => o.state === 'ADMISSIBLE' && o.candidate !== null && o.signed !== null);
        if (admissible.length === 0) return this.#result('NOTHING_TO_AUTHORIZE', active.version, epoch, outcomes, null);

        const participants: Participant[] = admissible.map((o) => {
          const c = o.candidate as TrustedCandidate;
          return { role: o.role, agent: (this.signers.get(o.role) as LocalAgentSigner).party, candidate: c, observedAt: o.observedAt, originalAtoms: o.sizeAtoms, minimumAtoms: c.resizable ? c.minAtoms : o.sizeAtoms };
        });
        const av = await availabilityAt(active.core, this.protocolNow());
        const demandAt = (p: Participant, atoms: bigint) => (atoms === 0n ? [] : demandOf(active.mandate, active.compiled.bindings, p.agent, p.candidate.build(atoms, p.observedAt), atoms, this.protocolNow()).demand);
        const fit = assess(participants, new Map(participants.map((p) => [p.role, p.originalAtoms])), av, demandAt);

        let room: RoomResult | null = null;
        let requests: ReadonlyMap<Role, bigint> = new Map(participants.map((p) => [p.role, p.originalAtoms]));
        if (!fit.feasible) {
          this.events.emit('PORTFOLIO_CONFLICT', {
            data: {
              authority: { atoms: fit.authorityAtoms, amount: usdcText(fit.authorityAtoms) },
              admissibleDemand: { atoms: fit.demandAtoms, amount: usdcText(fit.demandAtoms) },
              portfolioNotionalRequiredReduction: { atoms: fit.requiredAtoms, amount: usdcText(fit.requiredAtoms) },
              conflicts: conflictsOf(fit),
              constraints: fit.lines,
              agentExcess: fit.agentExcess.map((x) => ({ role: x.role, resource: x.resource, requested: usdcText(x.requestedAtoms), limit: usdcText(x.limitAtoms) })),
              excludedAtScreening: outcomes.filter((o) => o.state === 'BLOCKED').map((o) => o.role),
            },
          });
          this.#rooms += 1;
          room = await runLiveRoom(
            { provider: this.provider, clock: this.clock, events: this.events, roundTimeoutMs: this.#o.roomRoundTimeoutMs, maxGenerations: this.#o.maxGenerations ?? DEFAULT_MAX_GENERATIONS, superseded: signal },
            { roomId: `room-v${active.version}-${this.#rooms}`, version: active.version, participants, availability: av, demandAt },
          );
          this.#drains.push(room.drain);
          if (room.status === 'SUPERSEDED') {
            this.#markSuperseded(admissible);
            continue;
          }
          if (room.status === 'NO_FEASIBLE_PORTFOLIO') return this.#result('NO_FEASIBLE_PORTFOLIO', active.version, epoch, outcomes, room);
          requests = room.requests;
        }
        if (signal.aborted) {
          this.#markSuperseded(admissible);
          continue;
        }
        return await this.#authorizeFinal(active, epoch, outcomes, room, participants, requests);
      }
      return this.#result('SUPERSEDED_TOO_OFTEN', this.versions.active?.version ?? null, MAX_EPOCHS, [], null);
    } finally {
      this.#running = false;
    }
  }

  #result(status: RunStatus, version: number | null, epochs: number, discovery: readonly AgentOutcome[], room: RoomResult | null, extra: Partial<RunResult> = {}): RunResult {
    return { status, version, epochs, discovery, room, final: [], refreshed: [], receipts: [], reservedAtoms: 0n, executorCalls: 0, transactions: 0, ...extra };
  }

  /** Sign what the Room agreed, hand it to the real Mandate path, and account for every proposal. */
  async #reverify(active: ActiveMandate, phase: 'FINAL' | 'REFRESH', items: readonly { readonly role: Role; readonly candidateId: string; readonly signed: SignedProposal }[]): Promise<{ readonly run: ProtocolRun | null; readonly proposals: readonly FinalProposal[]; readonly reserved: bigint }> {
    if (!this.versions.beginReservation()) {
      return { run: null, proposals: items.map((i) => ({ role: i.role, proposal: proposalDigest(i.signed.proposal), requested: 0n, outcome: 'REFUSED', reasons: ['SESSION:AUTHORIZATION_IN_PROGRESS'] })), reserved: 0n };
    }
    let reservedAny = false;
    try {
      const now = this.protocolNow();
      const authority = this.#authority(active.version);
      this.events.emit('MANDATE_REVERIFY_STARTED', { data: { phase, proposals: items.map((i) => ({ role: i.role, proposal: proposalDigest(i.signed.proposal), requested: amountViews(i.signed.proposal.requested) })), path: 'Mandate Room → Portfolio Verifier → ledger reservation → domain executor', authority: authority === undefined ? 'V1_PREHASH' : 'V2_EIP712' } });
      const run = await runProtocol(active.core, active.signature, now, items.map((i) => i.signed), authority);
      const r = run.run;
      const children = r.verification.status === 'VERIFIED' ? r.verification.children : [];
      // The transcript runPortfolio verified, re-formed from what it returned (a pure projection of its inputs).
      const transcript = verificationTranscript({ mandate: active.mandate, signature: active.signature, ...(authority === undefined ? {} : { authority }), bindings: active.compiled.bindings, availability: r.before, now, candidate: r.room.candidate, proposals: r.room.proposals, releases: r.room.signedReleases });
      let reserved = 0n;
      const proposals: FinalProposal[] = items.map((i) => {
        const d = proposalDigest(i.signed.proposal);
        const decision = r.room.decisions.filter((x) => x.proposal === d).at(-1);
        const child = children.find((c) => c.proposal === d);
        const reservation = child === undefined ? undefined : r.reservations.find((x) => x.child === child.digest);
        const requested = i.signed.proposal.requested.find((a) => a.resource === 'portfolio-notional')?.atoms ?? 0n;
        const reasons: Reason[] = [...(decision?.reasons ?? []), ...(reservation?.reasons ?? [])];
        const record = child === undefined ? undefined : r.records.get(child.digest);
        if (reservation?.status === 'RESERVED' && child !== undefined && record !== undefined) {
          reserved += requested;
          const x: ReservedExecution = { role: i.role, version: active.version, phase, candidateId: i.candidateId, signed: i.signed, verified: child, record, transcript, receiptDigest: r.digest, reservedAt: now };
          this.#reserved.push(x);
          this.store?.putReserved(record.reservation, encodeRecord(x));
          return { role: i.role, proposal: d, requested, outcome: 'RESERVED', reasons: [] };
        }
        const stale = reasons.some((x) => x.code === 'QUOTE_STALE');
        if (stale) this.events.emit('PROPOSAL_STALE', { agent: i.role, data: { cause: 'QUOTE_STALE', proposal: d, reasons: reasonCodes(reasons), next: 'REFRESH_REQUIRED', note: 'A stale quote is never re-stamped: only a new observation and a new decision can replace it.' } });
        return { role: i.role, proposal: d, requested, outcome: stale ? 'STALE' : 'REFUSED', reasons: reasonCodes(reasons) };
      });
      reservedAny = reserved > 0n;
      const ledger = await ledgerView(active.core);
      const summary = {
        phase,
        verification: r.verification.status,
        verificationReasons: r.verification.status === 'REFUSED' ? reasonCodes(r.verification.reasons) : [],
        proposals: proposals.map((p) => ({ role: p.role, outcome: p.outcome, requested: usdcText(p.requested), reasons: p.reasons })),
        reserved: { atoms: reserved, amount: usdcText(reserved) },
        executions: r.executions.map((e) => ({ status: e.status, evidence: e.evidence, integration: e.integration })),
        receiptDigest: r.digest,
        executorCalls: run.executorCalls,
        transactions: run.transactions,
        ledgerVersion: ledger.version,
      };
      this.events.emit(reservedAny ? 'PORTFOLIO_AUTHORIZED' : 'PORTFOLIO_REFUSED', { data: summary });
      return { run, proposals, reserved };
    } finally {
      this.versions.endReservation(reservedAny);
    }
  }

  async #authorizeFinal(active: ActiveMandate, epoch: number, outcomes: readonly AgentOutcome[], room: RoomResult | null, participants: readonly Participant[], requests: ReadonlyMap<Role, bigint>): Promise<RunResult> {
    const now = this.protocolNow();
    const items: { role: Role; candidateId: string; signed: SignedProposal }[] = [];
    for (const p of participants) {
      const atoms = requests.get(p.role) ?? 0n;
      if (atoms === 0n) continue;
      const signer = this.signers.get(p.role) as LocalAgentSigner;
      // The agreed size, the original quote time, a new sequence: a fresh signature, never a fresh quote.
      const built = buildProposal({ mandate: active.mandate, bindings: active.compiled.bindings, agent: signer.party, candidate: p.candidate.build(atoms, p.observedAt), sizeAtoms: atoms, minimumAtoms: p.minimumAtoms < atoms ? p.minimumAtoms : atoms, sequence: this.#sequences.next(signer.party), now });
      if (!built.ok) continue;
      const signed = signer.sign(built.proposal);
      this.events.emit('PROPOSAL_SIGNED', { agent: p.role, data: { phase: 'FINAL', proposal: proposalDigest(signed.proposal), signer: signer.party.value, sequence: signed.proposal.sequence, requested: amountViews(built.demand), quoteObservedAt: p.observedAt } });
      items.push({ role: p.role, candidateId: p.candidate.id, signed });
    }
    if (items.length === 0) return this.#result('NOTHING_TO_AUTHORIZE', active.version, epoch, outcomes, room);
    const first = await this.#reverify(active, 'FINAL', items);
    let reserved = first.reserved;
    let executorCalls = first.run?.executorCalls ?? 0;
    const receipts = first.run === null ? [] : [first.run.run.digest as string];

    // Freshness: a stale proposal gets one genuinely fresh cycle — a new quote and a new decision — bounded by what the Room agreed.
    const refreshed: FinalProposal[] = [];
    const stale = first.proposals.filter((p) => p.outcome === 'STALE');
    if (stale.length > 0 && (this.#o.maxRefreshes ?? 1) > 0 && this.versions.active?.version === active.version) {
      const fresh = await Promise.all(
        stale.map((s) => {
          const p = participants.find((x) => x.role === s.role) as Participant;
          const agreed = requests.get(s.role) ?? p.originalAtoms;
          const c = p.candidate;
          const bounded: TrustedCandidate = { ...c, minAtoms: c.minAtoms < agreed ? c.minAtoms : agreed, maxAtoms: agreed };
          return discoverAgent(this.#deps(), active, s.role, { candidates: [bounded] });
        }),
      );
      const ready = fresh.filter((o) => o.state === 'ADMISSIBLE' && o.signed !== null && o.candidate !== null).map((o) => ({ role: o.role, candidateId: (o.candidate as TrustedCandidate).id, signed: o.signed as SignedProposal }));
      if (ready.length > 0) {
        const second = await this.#reverify(active, 'REFRESH', ready);
        refreshed.push(...second.proposals);
        reserved += second.reserved;
        executorCalls += second.run?.executorCalls ?? 0;
        if (second.run !== null) receipts.push(second.run.run.digest as string);
      }
    }
    const reservedCount = [...first.proposals, ...refreshed].filter((p) => p.outcome === 'RESERVED').length;
    const status: RunStatus = reservedCount === 0 ? 'REFUSED' : reservedCount === items.length ? 'AUTHORIZED' : 'PARTIALLY_AUTHORIZED';
    return this.#result(status, active.version, epoch, outcomes, room, { final: first.proposals, refreshed, receipts, reservedAtoms: reserved, executorCalls, transactions: 0 });
  }

  // --- Policy stress ------------------------------------------------------------------------

  /**
   * The policy-stress run (docs/demo/live-ai-lab.md §7): a model selects
   * preconstructed cases, each signed by the swap agent's own signer and
   * decided by the real Mandate path under the version active at the time.
   */
  async runPolicyStress(o: { readonly maxAttempts?: number } = {}): Promise<PolicyStressResult> {
    if (this.#running) throw new Error('this session is already running');
    if (this.restored) throw new Error('a restored session runs no agents');
    this.#running = true;
    try {
      const signer = this.signers.get('swap') as LocalAgentSigner;
      return await runPolicyStress(
        {
          provider: this.provider,
          clock: this.clock,
          events: this.events,
          signer,
          sameSignerAsSwapAgent: signer === this.signers.get('swap'),
          sequences: this.#sequences,
          protocolNow: this.protocolNow,
          timeoutMs: this.#o.agentTimeoutMs,
          current: () => this.versions.active,
          submit: (active, signed) => this.#submitOne(active, signed),
        },
        o,
      );
    } finally {
      this.#running = false;
    }
  }

  /** One signed proposal through runPortfolio, holding the version still; reports what the ledger looked like before and after. */
  async #submitOne(active: ActiveMandate, signed: SignedProposal): Promise<Submission> {
    const before = await ledgerView(active.core);
    if (!this.versions.beginReservation()) {
      return { submitted: false, reserved: false, reasons: [], verification: 'NOT_RUN', receiptDigest: null, ledgerVersionBefore: before.version, ledgerVersionAfter: before.version, reservationsBefore: before.reservations.length, reservationsAfter: before.reservations.length, runtime: 'SESSION:AUTHORIZATION_IN_PROGRESS' };
    }
    let reserved = false;
    try {
      const run = (await runProtocol(active.core, active.signature, this.protocolNow(), [signed], this.#authority(active.version))).run;
      const d = proposalDigest(signed.proposal);
      const decision = run.room.decisions.filter((x) => x.proposal === d).at(-1);
      const child = run.verification.status === 'VERIFIED' ? run.verification.children.find((c) => c.proposal === d) : undefined;
      const reservation = child === undefined ? undefined : run.reservations.find((x) => x.child === child.digest);
      reserved = reservation?.status === 'RESERVED';
      const reasons: Reason[] = [...(decision?.reasons ?? []), ...(run.verification.status === 'REFUSED' ? run.verification.reasons : []), ...(reservation?.reasons ?? [])];
      const after = await ledgerView(active.core);
      return {
        submitted: true,
        reserved,
        reasons: reserved ? [] : [...new Set(reasonCodes(reasons))],
        verification: run.verification.status,
        receiptDigest: run.digest,
        ledgerVersionBefore: before.version,
        ledgerVersionAfter: after.version,
        reservationsBefore: before.reservations.length,
        reservationsAfter: after.reservations.length,
        runtime: null,
      };
    } finally {
      this.versions.endReservation(reserved);
    }
  }

  /** Wait for every late reply to land (each is bounded by its own timeout), then close the stream. */
  async complete(summary: { readonly [k: string]: unknown } = {}): Promise<void> {
    await Promise.all(this.#drains.map((d) => d()));
    this.events.emit('SESSION_COMPLETED', { data: { versions: this.versions.records.map((r) => ({ version: r.version, status: r.status, digest: r.digest })), ...summary } });
  }
}
