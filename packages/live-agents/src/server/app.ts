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
 * Sessions are in memory, few, and expire when idle. Nothing here signs
 * outside a session, sends a transaction or writes a file.
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
import { LiveSession, type RunResult } from '../session.ts';
import { LIVE_SCHEMA, safe, type LiveEvent } from '../telemetry/events.ts';
import { summarizePolicyStress, summarizeRun } from '../telemetry/summary.ts';
import { ROLES, ROLE_LABELS } from '../types.ts';
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
}

interface Entry {
  readonly session: LiveSession;
  readonly provider: string;
  draft: MandateDraft | null;
  task: 'RUN' | 'POLICY_STRESS' | null;
  lastRun: RunResult | null;
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
    for (const [id, e] of this.#sessions) if (e.task === null && now - e.touchedMs > (this.#o.idleMs ?? 30 * 60_000)) this.#sessions.delete(id);
  }

  async #route(r: ApiRequest): Promise<ApiResponse> {
    if (!r.path.startsWith(API)) return refuse(404, 'NOT_FOUND', 'No such endpoint.');
    const parts = r.path.slice(API.length).split('/').filter((p) => p !== '');
    if (r.method === 'GET' && parts.length === 1 && parts[0] === 'status') return this.#status();
    if (r.method === 'POST' && parts.length === 1 && parts[0] === 'sessions') return this.#create(r.body);
    if (parts[0] !== 'sessions' || parts[1] === undefined) return refuse(404, 'NOT_FOUND', 'No such endpoint.');
    const entry = this.#sessions.get(parts[1]);
    if (entry === undefined) return refuse(404, 'SESSION_NOT_FOUND', 'No such session; it may have expired.');
    entry.touchedMs = this.#o.clock.nowMs();
    const action = parts.slice(2).join('/');
    if (r.method === 'GET' && action === '') return ok(this.#view(entry));
    if (r.method !== 'POST') return refuse(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    const body = isObject(r.body) ? r.body : {};
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
        methods: ['WALLET_EIP712', 'DEMO_PRINCIPAL_KEY'],
        wallet: { chainId: APPROVAL_CHAIN_ID, environment: APPROVAL_ENVIRONMENT, domain: { name: APPROVAL_DOMAIN.name, version: APPROVAL_DOMAIN.version }, delegatesDomainExecution: false },
      },
      roles: ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r], domain: AGENT_DOMAINS[r], objective: DOMAIN_AGENTS[r].objective, candidates: DOMAIN_AGENTS[r].candidates.map((c) => ({ id: c.id, title: c.title })) })),
      catalog: Object.fromEntries(CATALOG_SETS.map((s) => [s, CATALOG[s].map((e) => ({ id: e.id, label: e.label }))])),
      policyCases: POLICY_CASE_IDS.map((id) => ({ caseId: id, description: POLICY_CASES[id] })),
      maxPolicyStressAttempts: MAX_POLICY_STRESS_ATTEMPTS,
      allowChaos: this.#o.allowChaos,
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
    const id = `lab-${entropy.bytes32().slice(2, 34)}`;
    const session = new LiveSession({ provider, clock: this.#o.clock, sessionId: id, agentTimeoutMs: this.#o.agentTimeoutMs, roomRoundTimeoutMs: this.#o.roomRoundTimeoutMs, chaos, entropy });
    const entry: Entry = { session, provider: provider.name, draft: null, task: null, lastRun: null, lastPolicyStress: null, lastError: null, touchedMs: this.#o.clock.nowMs() };
    this.#sessions.set(id, entry);
    return ok({ sessionId: id, ...this.#view(entry) }, 201);
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
      validation: v === null ? null : { ok: v.ok, issues: v.issues, guardrails: v.guardrails },
      expectedConfirmation: s.versions.expectedConfirmation,
      activeVersion: s.versions.active?.version ?? null,
      paused: s.versions.paused,
      reserved: s.versions.reserved,
      versions: s.versions.records,
      task: entry.task,
      lastRun: entry.lastRun === null ? null : summarizeRun(entry.lastRun),
      lastPolicyStress: entry.lastPolicyStress === null ? null : summarizePolicyStress(entry.lastPolicyStress),
      lastError: entry.lastError,
      events: s.events.events.length,
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
    const r = entry.session.walletChallenge(entry.draft, address);
    if (!r.ok) return { status: 409, body: safe({ error: r.code, message: r.message, ...this.#view(entry) }) };
    return ok({ challenge: r.challenge, version: r.version, digest: r.digest, principal: r.principal, validUntil: r.validUntil, typedData: r.typedData, ...this.#view(entry) });
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

  /** Start a run or a policy-stress test in the background; its progress is the event stream. */
  #start(entry: Entry, task: 'RUN' | 'POLICY_STRESS', body: JsonObject): ApiResponse {
    if (entry.task !== null) return refuse(409, 'BUSY', `A ${entry.task === 'RUN' ? 'run' : 'policy-stress test'} is in progress.`);
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
