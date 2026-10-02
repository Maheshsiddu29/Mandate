/**
 * The local Live AI Lab API, independent of any transport
 * (docs/demo/live-ai-lab.md §10).
 *
 * The browser talks to this; this talks to the model provider. The OpenAI
 * key stays in the provider this module was given — no response, event or
 * error carries it, and a session reports only whether the live provider
 * is available. Every request body is parsed field by field: a draft is
 * edited only through the typed field table, and authorization needs either
 * the principal's wallet signature over a server-issued challenge (verified
 * here against server state; the browser sends only the signature) or, on the
 * demonstration key path, the principal's exact confirmation text.
 *
 * Sessions are few and leave memory when idle. With a state directory they
 * are durable (persistence/session-store.ts): an unknown session id is
 * restored from disk on first use, as evidence — a restored session runs no
 * agents and authorizes nothing new — and events another process appended
 * (a settlement command) are picked up by `syncEvents`. Nothing here signs
 * outside a session or sends a transaction.
 */

import { DOMAIN_AGENTS } from '../agents/index.ts';
import { AGENT_DOMAINS, CATALOG, CATALOG_SETS } from '../authoring/catalog.ts';
import { parseFieldValue, resolveIssue } from '../authoring/draft-fields.ts';
import { PRESETS, withField, type MandateDraft, type Preset } from '../authoring/draft-types.ts';
import type { DraftValidation } from '../authoring/draft-validator.ts';
import { PAUSE_CONFIRMATION } from '../authoring/mandate-versioning.ts';
import { POLICY_CASES, POLICY_CASE_IDS } from '../policy-stress/cases.ts';
import { MAX_POLICY_STRESS_ATTEMPTS, type PolicyStressResult } from '../policy-stress/runner.ts';
import type { Clock } from '../runtime/clock.ts';
import { realEntropy, type Entropy } from '../runtime/entropy.ts';
import { LatencyChaosProvider, parseChaosSpec } from '../runtime/latency-chaos.ts';
import type { AgentModelProvider } from '../runtime/provider.ts';
import { isObject, type JsonObject, type JsonValue } from '../runtime/strict-json.ts';
import { StubProvider } from '../runtime/stub-provider.ts';
import { reservationLedgerStatus } from '../mandate/portfolio-adapter.ts';
import { sessionExists } from '../persistence/session-store.ts';
import { LiveSession, type RunResult } from '../session.ts';
import type { AllocationPlan } from '../allocation/planning.ts';
import type { OpportunityScorer } from '../jev/scorer.ts';
import { ROLES, ROLE_LABELS, usdcText, isRole, type Role } from '../types.ts';
import { LIVE_SCHEMA, safe, type LiveEvent } from '../telemetry/events.ts';
import { summarizePolicyStress, summarizeRun } from '../telemetry/summary.ts';
import { APPROVAL_CHAIN_ID, APPROVAL_DOMAIN, APPROVAL_ENVIRONMENT } from '../wallet/approval.ts';

export interface ApiRequest {
  readonly method: string;
  /** Path without the query string. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** Parsed JSON body, or null. */
  readonly body: JsonValue | null;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: JsonValue;
}

export interface LabOptions {
  /** The live provider, when OPENAI_API_KEY is configured; null otherwise. */
  readonly live: AgentModelProvider | null;
  readonly clock: Clock;
  readonly agentTimeoutMs: number;
  readonly roomRoundTimeoutMs: number;
  /** Development only: allow a latency chaos spec per session. */
  readonly allowChaos: boolean;
  readonly maxSessions?: number;
  readonly idleMs?: number;
  /** Randomness for session ids and wallet challenges; tests substitute a deterministic source. */
  readonly entropy?: Entropy;
  /** Durable sessions live here; absent: in memory only. */
  readonly stateDir?: string;
  /** Advisory opportunity scoring (Jev) for Planning and Reallocation Rooms; absent: none, and none is invented. */
  readonly scorer?: OpportunityScorer;
}

/**
 * What this server's discovery offers a model, advertised so a browser can
 * refuse to run against a server built from older code that offered
 * discovery-only candidates (docs/v2/mandate-room-v2.md §1.5).
 */
export const CANDIDATE_PIPELINE = 'DISCOVERED>ACTIONABLE>EXECUTABLE>MODEL';
export const ROOM_SEMANTICS = 'MANDATE_ROOM_V2';

/** A plan as the browser sees it: budgets, what stays unallocated, why, and each agent's declared rationale. */
export function summarizePlan(p: AllocationPlan): { readonly [k: string]: unknown } {
  const v = (atoms: bigint) => ({ atoms, amount: usdcText(atoms) });
  return {
    roomId: p.roomId,
    roomPurpose: p.purpose,
    pool: v(p.poolAtoms),
    fixed: p.fixed.map((f) => ({ role: f.role, budget: v(f.atoms) })),
    budgets: p.allocations.map((a) => {
      const c = p.cards.find((x) => x.role === a.role);
      return { role: a.role, budget: v(a.atoms), zero: a.zero, capped: a.capped, action: c?.action ?? null, candidate: c?.candidateTitle ?? null, rationale: c?.rationale ?? null, marketRegime: c?.marketRegime ?? null, runtime: c?.runtime ?? null };
    }),
    allocated: v(p.allocatedAtoms),
    unallocated: v(p.unallocatedAtoms),
    explanation: p.explanation,
    freshUntil: p.freshUntil,
    jev: p.jev,
    evidence: { market: 'FIXTURE', inference: p.cards[0]?.modelEvidence ?? null },
  };
}

interface Entry {
  readonly session: LiveSession;
  readonly provider: string;
  draft: MandateDraft | null;
  task: 'RUN' | 'POLICY_STRESS' | 'PLAN' | null;
  lastRun: RunResult | null;
  lastPlan: AllocationPlan | null;
  lastPlanError: string | null;
  lastPolicyStress: PolicyStressResult | null;
  lastError: string | null;
  touchedMs: number;
}

const MAX_PROMPT = 2_000;
const API = '/api/live';

const ok = (body: { readonly [k: string]: unknown }, status = 200): ApiResponse => ({ status, body: safe(body) });
const refuse = (status: number, error: string, message: string): ApiResponse => ({ status, body: { error, message } });

export class LiveLab {
  readonly #o: LabOptions;
  readonly #sessions = new Map<string, Entry>();

  constructor(o: LabOptions) {
    this.#o = o;
  }

  get maxSessions(): number {
    return this.#o.maxSessions ?? 4;
  }

  /** Route one request. Never throws: an unexpected failure is a 500 with no detail. */
  async handle(r: ApiRequest): Promise<ApiResponse> {
    try {
      return await this.#route(r);
    } catch (e) {
      return refuse(500, 'INTERNAL', `The server could not complete the request (${e instanceof Error ? e.name : 'error'}).`);
    }
  }

  /**
   * The session, from memory or — when durable and not in memory, after a
   * restart or an idle sweep — restored from disk. `null` when it does not
   * exist or its records are corrupt (fail closed).
   */
  async ensure(id: string): Promise<boolean> {
    if (this.#sessions.has(id)) return true;
    const dir = this.#o.stateDir;
    if (dir === undefined || !sessionExists(dir, id)) return false;
    let session: LiveSession;
    try {
      session = await LiveSession.restore(dir, id, { clock: this.#o.clock, agentTimeoutMs: this.#o.agentTimeoutMs, roomRoundTimeoutMs: this.#o.roomRoundTimeoutMs, by: 'local-server', ...(this.#o.entropy === undefined ? {} : { entropy: this.#o.entropy }) });
    } catch {
      return false;
    }
    if (this.#sessions.has(id)) {
      session.close();
      return true;
    }
    this.#sessions.set(id, { session, provider: session.provider.name, draft: session.recordedDraft, task: null, lastRun: null, lastPlan: null, lastPlanError: null, lastPolicyStress: null, lastError: null, touchedMs: this.#o.clock.nowMs() });
    return true;
  }

  /**
   * The in-memory session, restoring it from disk when this lab is durable.
   * Settlement uses this same object so its events reach the browser stream.
   * A restored session may be settled: the reservation already exists. This
   * does not authorize a new mandate version.
   */
  async openSession(id: string): Promise<LiveSession | null> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return null;
    if (!(await this.ensure(id))) return null;
    const entry = this.#sessions.get(id);
    if (entry === undefined) return null;
    entry.touchedMs = this.#o.clock.nowMs();
    return entry.session;
  }

  /** The background task on an in-memory session, if one is running. */
  taskOf(id: string): 'RUN' | 'POLICY_STRESS' | 'PLAN' | null {
    return this.#sessions.get(id)?.task ?? null;
  }

  /** Pick up events other processes appended to durable sessions; listeners hear them in order. */
  syncEvents(): void {
    for (const e of this.#sessions.values()) {
      try {
        e.session.events.sync();
      } catch {
        e.lastError = 'SessionStoreCorruption';
      }
    }
  }

  /** Events of a session from `after` on, then every new one; `null` for an unknown session. */
  subscribe(id: string, after: number, listener: (e: LiveEvent) => void): (() => void) | null {
    const entry = this.#sessions.get(id);
    if (entry === undefined) return null;
    entry.touchedMs = this.#o.clock.nowMs();
    for (const e of entry.session.events.events) if (e.sequence > after) listener(e);
    return entry.session.events.subscribe(listener);
  }

  /** Drop sessions idle longer than the bound. */
  sweep(): void {
    const now = this.#o.clock.nowMs();
    for (const [id, e] of this.#sessions) {
      if (e.task === null && now - e.touchedMs > (this.#o.idleMs ?? 30 * 60_000)) {
        this.#sessions.delete(id);
        e.session.close();
      }
    }
  }

  async #route(r: ApiRequest): Promise<ApiResponse> {
    if (!r.path.startsWith(API)) return refuse(404, 'NOT_FOUND', 'No such endpoint.');
    const parts = r.path.slice(API.length).split('/').filter((p) => p !== '');
    if (r.method === 'GET' && parts.length === 1 && parts[0] === 'status') return this.#status();
    if (r.method === 'POST' && parts.length === 1 && parts[0] === 'sessions') return this.#create(r.body);
    if (parts[0] !== 'sessions' || parts[1] === undefined) return refuse(404, 'NOT_FOUND', 'No such endpoint.');
    await this.ensure(parts[1]);
    const entry = this.#sessions.get(parts[1]);
    if (entry === undefined) return refuse(404, 'SESSION_NOT_FOUND', 'No such session; it may have expired.');
    entry.touchedMs = this.#o.clock.nowMs();
    const action = parts.slice(2).join('/');
    if (r.method === 'GET' && action === '') {
      entry.session.events.sync();
      return ok({ ...this.#view(entry), reservations: await this.#reservations(entry) });
    }
    if (r.method !== 'POST') return refuse(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    const body = isObject(r.body) ? r.body : {};
    if (entry.session.restored && action !== 'pause') return refuse(409, 'SESSION_RESTORED', 'This session was restored from disk after a restart: it is evidence only. It runs no agents and authorizes nothing new; pause is still available. Start a new session to trade.');
    const before = entry.draft;
    const res = await this.#act(entry, action, body);
    if (entry.draft !== before) entry.session.rememberDraft(entry.draft);
    return res;
  }

  async #act(entry: Entry, action: string, body: JsonObject): Promise<ApiResponse> {
    switch (action) {
      case 'draft':
        return this.#draft(entry, body);
      case 'draft/fill':
        return this.#fill(entry, body);
      case 'draft/field':
        return this.#field(entry, body);
      case 'draft/resolve':
        return this.#resolve(entry, body);
      case 'authorize':
        return this.#authorize(entry, body);
      case 'wallet/challenge':
        return this.#walletChallenge(entry, body);
      case 'wallet/authorize':
        return this.#walletAuthorize(entry, body);
      case 'pause':
        return this.#pause(entry, body);
      case 'plan':
        return this.#plan(entry);
      case 'draft/allocation':
        return this.#allocation(entry, body);
      case 'run':
        return this.#start(entry, 'RUN', body);
      case 'policy-stress':
        return this.#start(entry, 'POLICY_STRESS', body);
      default:
        return refuse(404, 'NOT_FOUND', 'No such endpoint.');
    }
  }

  #status(): ApiResponse {
    return ok({
      schema: LIVE_SCHEMA,
      providers: { openai: { available: this.#o.live !== null, model: this.#o.live?.model ?? null }, stub: { available: true } },
      presets: PRESETS,
      pauseConfirmation: PAUSE_CONFIRMATION,
      principalAuthorization: {
        methods: ['WALLET_EIP712', 'DEMO_PRINCIPAL_KEY', 'WALLET_PRINCIPAL_V2'],
        wallet: { chainId: APPROVAL_CHAIN_ID, environment: APPROVAL_ENVIRONMENT, domain: { name: APPROVAL_DOMAIN.name, version: APPROVAL_DOMAIN.version }, delegatesDomainExecution: false },
        spine: { method: 'WALLET_PRINCIPAL_V2', request: { spine: 'V2' }, domain: { name: 'Mandate', version: '2', chainId: APPROVAL_CHAIN_ID }, principalIsWallet: true, domainExecution: 'PER_EXECUTION_GATE_EIP712' },
      },
      roles: ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r], domain: AGENT_DOMAINS[r], objective: DOMAIN_AGENTS[r].objective, candidates: DOMAIN_AGENTS[r].candidates.map((c) => ({ id: c.id, title: c.title })) })),
      catalog: Object.fromEntries(CATALOG_SETS.map((s) => [s, CATALOG[s].map((e) => ({ id: e.id, label: e.label }))])),
      policyCases: POLICY_CASE_IDS.map((id) => ({ caseId: id, description: POLICY_CASES[id] })),
      maxPolicyStressAttempts: MAX_POLICY_STRESS_ATTEMPTS,
      allowChaos: this.#o.allowChaos,
      candidatePipeline: CANDIDATE_PIPELINE,
      roomSemantics: ROOM_SEMANTICS,
      jev: { available: this.#o.scorer !== undefined, evidence: this.#o.scorer?.evidence ?? 'NONE' },
      sessions: { open: this.#sessions.size, max: this.maxSessions },
    });
  }

  #create(raw: JsonValue | null): ApiResponse {
    this.sweep();
    if (this.#sessions.size >= this.maxSessions) return refuse(429, 'TOO_MANY_SESSIONS', `At most ${this.maxSessions} sessions at once; idle ones expire.`);
    const body = isObject(raw) ? raw : {};
    const kind = body['provider'] ?? 'stub';
    let provider: AgentModelProvider;
    if (kind === 'openai') {
      if (this.#o.live === null) return refuse(409, 'LIVE_PROVIDER_UNAVAILABLE', 'The server has no OPENAI_API_KEY. Start it with one, or use the stub provider.');
      provider = this.#o.live;
    } else if (kind === 'stub') {
      const seed = body['seed'];
      provider = new StubProvider(typeof seed === 'number' && Number.isSafeInteger(seed) ? seed : 0);
    } else {
      return refuse(400, 'BAD_REQUEST', 'provider must be "openai" or "stub".');
    }
    let chaos: string | null = null;
    if (body['chaos'] !== undefined && body['chaos'] !== null && body['chaos'] !== '') {
      if (!this.#o.allowChaos) return refuse(403, 'CHAOS_DISABLED', 'Latency chaos is development only; start the server with --dev-chaos.');
      if (typeof body['chaos'] !== 'string' || body['chaos'].length > 200) return refuse(400, 'BAD_REQUEST', 'chaos must be a short spec string.');
      const plan = parseChaosSpec(body['chaos']);
      if ('error' in plan) return refuse(400, 'BAD_REQUEST', plan.error);
      provider = new LatencyChaosProvider(provider, plan, this.#o.clock);
      chaos = body['chaos'];
    }
    const entropy = this.#o.entropy ?? realEntropy;
    // 128 random bits: unique across restarts and processes, never a timestamp.
    const id = `lab-${entropy.bytes32().slice(-32)}`;
    const session = new LiveSession({ provider, clock: this.#o.clock, sessionId: id, agentTimeoutMs: this.#o.agentTimeoutMs, roomRoundTimeoutMs: this.#o.roomRoundTimeoutMs, chaos, entropy, ...(this.#o.stateDir === undefined ? {} : { stateDir: this.#o.stateDir }), ...(this.#o.scorer === undefined ? {} : { scorer: this.#o.scorer }) });
    const entry: Entry = { session, provider: provider.name, draft: null, task: null, lastRun: null, lastPlan: null, lastPlanError: null, lastPolicyStress: null, lastError: null, touchedMs: this.#o.clock.nowMs() };
    this.#sessions.set(id, entry);
    return ok({ sessionId: id, ...this.#view(entry) }, 201);
  }

  /** Each reserved execution and what the durable ledger says of it now: the settlement path may have consumed or released it. */
  async #reservations(entry: Entry): Promise<readonly { readonly reservation: string; readonly role: string; readonly version: number; readonly status: string }[]> {
    const s = entry.session;
    const out: { reservation: string; role: string; version: number; status: string }[] = [];
    for (const x of s.reservedExecutions) {
      const core = s.versions.coreOf(x.version)?.core;
      out.push({ reservation: x.record.reservation, role: x.role, version: x.version, status: core === undefined ? 'UNKNOWN' : await reservationLedgerStatus(core, x.record.reservation) });
    }
    for (const o of s.orphans) out.push({ reservation: o, role: 'unknown', version: 0, status: 'ORPHANED' });
    return out;
  }

  #validation(entry: Entry): DraftValidation | null {
    return entry.draft === null ? null : entry.session.validate(entry.draft);
  }

  #view(entry: Entry): { readonly [k: string]: unknown } {
    const s = entry.session;
    const v = this.#validation(entry);
    return {
      sessionId: s.id,
      provider: { name: s.provider.name, kind: s.provider.kind, model: s.provider.model },
      draft: entry.draft,
      validation: v === null ? null : { ok: v.ok, issues: v.issues, guardrails: v.guardrails, allocation: v.allocation },
      expectedConfirmation: s.versions.expectedConfirmation,
      activeVersion: s.versions.active?.version ?? null,
      paused: s.versions.paused,
      reserved: s.versions.reserved,
      versions: s.versions.records,
      task: entry.task,
      lastRun: entry.lastRun === null ? null : summarizeRun(entry.lastRun),
      lastPolicyStress: entry.lastPolicyStress === null ? null : summarizePolicyStress(entry.lastPolicyStress),
      lastPlan: entry.lastPlan === null ? null : summarizePlan(entry.lastPlan),
      lastPlanError: entry.lastPlanError,
      lastError: entry.lastError,
      events: s.events.events.length,
      durable: s.store !== null,
      restored: s.restored,
      orphanedReservations: s.orphans,
    };
  }

  async #draft(entry: Entry, body: JsonObject): Promise<ApiResponse> {
    const preset = body['preset'];
    const prompt = body['prompt'];
    if (typeof preset === 'string') {
      if (!(PRESETS as readonly string[]).includes(preset)) return refuse(400, 'BAD_REQUEST', `preset must be one of ${PRESETS.join(', ')}.`);
      entry.draft = entry.session.presetDraft(preset as Preset);
      return ok(this.#view(entry));
    }
    if (typeof prompt === 'string') {
      if (prompt.trim() === '' || prompt.length > MAX_PROMPT) return refuse(400, 'BAD_REQUEST', `prompt must be 1–${MAX_PROMPT} characters.`);
      const r = await entry.session.interpret(prompt);
      if (r.draft === null) return refuse(422, 'DRAFT_NOT_INTERPRETED', `The prompt could not be interpreted: ${r.error ?? 'no draft'}.`);
      entry.draft = r.draft;
      return ok(this.#view(entry));
    }
    if (body['from'] === 'active') {
      const active = entry.session.versions.active;
      if (active === null) return refuse(409, 'NO_ACTIVE_MANDATE', 'There is no active version to amend.');
      entry.draft = active.draft;
      return ok(this.#view(entry));
    }
    return refuse(400, 'BAD_REQUEST', 'Give a preset, a prompt, or from: "active".');
  }

  #fill(entry: Entry, body: JsonObject): ApiResponse {
    const preset = body['preset'];
    if (entry.draft === null) return refuse(409, 'NO_DRAFT', 'Create a draft first.');
    if (typeof preset !== 'string' || !(PRESETS as readonly string[]).includes(preset)) return refuse(400, 'BAD_REQUEST', `preset must be one of ${PRESETS.join(', ')}.`);
    const r = entry.session.fillUnset(entry.draft, preset as Preset);
    entry.draft = r.draft;
    return ok({ filled: r.filled, ...this.#view(entry) });
  }

  #field(entry: Entry, body: JsonObject): ApiResponse {
    if (entry.draft === null) return refuse(409, 'NO_DRAFT', 'Create a draft first.');
    const f = parseFieldValue(body['path'], body['value'] ?? null);
    if (!f.ok) return refuse(400, 'BAD_REQUEST', f.error);
    entry.draft = withField(entry.draft, f.path, f.value, 'USER');
    return ok(this.#view(entry));
  }

  #resolve(entry: Entry, body: JsonObject): ApiResponse {
    if (entry.draft === null) return refuse(409, 'NO_DRAFT', 'Create a draft first.');
    const index = body['index'];
    const next = typeof index === 'number' ? resolveIssue(entry.draft, index) : null;
    if (next === null) return refuse(400, 'BAD_REQUEST', 'index must name an open issue.');
    entry.draft = next;
    return ok(this.#view(entry));
  }

  async #authorize(entry: Entry, body: JsonObject): Promise<ApiResponse> {
    if (entry.draft === null) return refuse(409, 'NO_DRAFT', 'Create a draft first.');
    const confirmation = body['confirmation'];
    if (typeof confirmation !== 'string' || confirmation.length > 64) return refuse(400, 'BAD_REQUEST', 'confirmation must be the exact text shown.');
    const r = await entry.session.authorize(entry.draft, confirmation);
    if (!r.ok) return { status: 409, body: safe({ error: r.code, message: r.message, issues: r.issues, ...this.#view(entry) }) };
    return ok({ record: r.record, superseded: r.superseded, ...this.#view(entry) });
  }

  #walletChallenge(entry: Entry, body: JsonObject): ApiResponse {
    if (entry.draft === null) return refuse(409, 'NO_DRAFT', 'Create a draft first.');
    const address = body['address'];
    if (typeof address !== 'string' || address.length > 42) return refuse(400, 'BAD_REQUEST', 'address must be the connected wallet address.');
    const spine = body['spine'];
    if (spine !== undefined && spine !== 'V2') return refuse(400, 'BAD_REQUEST', 'spine must be "V2" or omitted. Omitted is the B.5.3 wallet approval.');
    const r = spine === 'V2' ? entry.session.spineChallenge(entry.draft, address) : entry.session.walletChallenge(entry.draft, address);
    if (!r.ok) return { status: 409, body: safe({ error: r.code, message: r.message, ...this.#view(entry) }) };
    return ok({ challenge: r.challenge, version: r.version, digest: r.digest, principal: r.principal, validUntil: r.validUntil, typedData: r.typedData, spine: spine === 'V2' ? 'V2' : 'V1', ...this.#view(entry) });
  }

  async #walletAuthorize(entry: Entry, body: JsonObject): Promise<ApiResponse> {
    if (entry.draft === null) return refuse(409, 'NO_DRAFT', 'Create a draft first.');
    const challenge = body['challenge'];
    const signature = body['signature'];
    if (typeof challenge !== 'string' || !/^0x[0-9a-f]{64}$/.test(challenge)) return refuse(400, 'BAD_REQUEST', 'challenge must be the id the server issued.');
    if (typeof signature !== 'string' || signature.length > 140) return refuse(400, 'BAD_REQUEST', 'signature must be the wallet signature.');
    const r = await entry.session.authorizeWithWallet(entry.draft, challenge, signature);
    if (!r.ok) return { status: 409, body: safe({ error: r.code, message: r.message, issues: r.issues, ...this.#view(entry) }) };
    return ok({ record: r.record, superseded: r.superseded, ...this.#view(entry) });
  }

  async #pause(entry: Entry, body: JsonObject): Promise<ApiResponse> {
    const confirmation = body['confirmation'];
    if (typeof confirmation !== 'string' || confirmation.length > 64) return refuse(400, 'BAD_REQUEST', 'confirmation must be the exact text shown.');
    const paused = await entry.session.pause(confirmation);
    if (!paused) return { status: 409, body: safe({ error: 'PAUSE_REFUSED', message: `Pausing needs an active mandate and the exact confirmation "${PAUSE_CONFIRMATION}".`, ...this.#view(entry) }) };
    return ok(this.#view(entry));
  }

  /** Ask the agents the principal left the split to for a proposed allocation, in the background; its progress is the event stream. */
  #plan(entry: Entry): ApiResponse {
    if (entry.draft === null) return refuse(409, 'NO_DRAFT', 'Create a draft first.');
    if (entry.task !== null) return refuse(409, 'BUSY', 'Another task is in progress.');
    const draft = entry.draft;
    entry.task = 'PLAN';
    entry.lastPlanError = null;
    void entry.session
      .plan(draft)
      .then((r) => {
        if (r.ok) entry.lastPlan = r.plan;
        else entry.lastPlanError = `${r.code}: ${r.message}`;
      })
      .catch((e: unknown) => {
        entry.lastPlanError = e instanceof Error ? e.name : 'error';
      })
      .finally(() => {
        entry.task = null;
      });
    return ok({ started: 'PLAN', ...this.#view(entry) }, 202);
  }

  /** Use a proposed split, with the principal's edits: budgets are written into the draft and validated. Nothing is signed. */
  #allocation(entry: Entry, body: JsonObject): ApiResponse {
    if (entry.draft === null) return refuse(409, 'NO_DRAFT', 'Create a draft first.');
    if (entry.task !== null) return refuse(409, 'BUSY', 'Another task is in progress.');
    const plan = body['plan'];
    if (typeof plan !== 'string' || !/^[a-z0-9-]{1,64}$/.test(plan)) return refuse(400, 'BAD_REQUEST', 'plan must be the id of a proposed split.');
    const raw = body['budgets'] ?? {};
    if (!isObject(raw)) return refuse(400, 'BAD_REQUEST', 'budgets must map agent roles to USDC amounts.');
    const edits: { [R in Role]?: string } = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!isRole(k) || typeof v !== 'string' || v.length > 24 || /[\u0000-\u001f\u007f]/.test(v)) return refuse(400, 'BAD_REQUEST', 'budgets must map agent roles to USDC amounts.');
      edits[k] = v.trim();
    }
    const r = entry.session.applyPlan(entry.draft, plan, edits);
    if (!r.ok) return { status: 409, body: safe({ error: r.code, message: r.message, ...this.#view(entry) }) };
    entry.draft = r.draft;
    return ok(this.#view(entry));
  }

  /** Start a run or a policy-stress test in the background; its progress is the event stream. */
  #start(entry: Entry, task: 'RUN' | 'POLICY_STRESS', body: JsonObject): ApiResponse {
    if (entry.task !== null) return refuse(409, 'BUSY', `A ${entry.task === 'RUN' ? 'run' : entry.task === 'PLAN' ? 'planning pass' : 'policy-stress test'} is in progress.`);
    if (entry.session.versions.active === null) return refuse(409, 'NO_ACTIVE_MANDATE', 'Authorize a mandate version first.');
    const attempts = body['maxAttempts'];
    if (attempts !== undefined && (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_POLICY_STRESS_ATTEMPTS)) return refuse(400, 'BAD_REQUEST', `maxAttempts must be 1–${MAX_POLICY_STRESS_ATTEMPTS}.`);
    entry.task = task;
    entry.lastError = null;
    const work =
      task === 'RUN'
        ? entry.session.run().then((r) => {
            entry.lastRun = r;
          })
        : entry.session.runPolicyStress(typeof attempts === 'number' ? { maxAttempts: attempts } : {}).then((r) => {
            entry.lastPolicyStress = r;
          });
    void work
      .catch((e: unknown) => {
        entry.lastError = e instanceof Error ? e.name : 'error';
      })
      .finally(() => {
        entry.task = null;
      });
    return ok({ started: task, ...this.#view(entry) }, 202);
  }
}
