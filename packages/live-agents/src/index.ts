/**
 * @mandate/live-agents — the Live AI Lab (docs/demo/live-ai-lab.md).
 *
 * The public surface the command-line runner and the local API server use.
 * Nothing exported here holds or returns a key: signers are reachable only
 * through a session, and the OpenAI provider keeps its key in a private
 * field.
 */

export { ROLES, ROLE_LABELS, AGENT_RUNTIME_STATES, usdcText, parseUsdc, isRole, type Role, type AgentRuntimeState } from './types.ts';
export { readConfig, describeConfig, DEFAULTS, type LiveConfig } from './config.ts';
export { LiveSession, type SessionOptions, type RestoreOptions, type RunResult, type RunStatus, type FinalProposal, type ReservedExecution, type WalletChallengeResult } from './session.ts';
export { SessionStore, SessionStoreCorruption, sessionExists, sessionDir, SESSION_SCHEMA } from './persistence/session-store.ts';
export { emptyDraft, presetDraft, applyPreset, withField, fieldAt, PRESETS, ISSUE_KINDS, HUMAN_FIELD_SOURCES, FIELD_SOURCES, type MandateDraft, type Preset, type DraftIssue, type FieldSource, type FieldEvidence } from './authoring/draft-types.ts';
export { compileMandateDraft, compileLocalPrompt, mergeFormOntoPrompt, overAllocationIssues, type CompileInput, type CompileResult } from './authoring/compiler.ts';
export {
  isDangerousUnsupported,
  isSoftUnsupported,
  resolveIssueSafe,
  choosePortfolioTotal,
  draftIssuesBlockAuthorize,
  type ResolveRefusal,
} from './authoring/issue-policy.ts';
export { DRAFT_FIELD_PATHS, parseFieldValue } from './authoring/draft-fields.ts';
export { CATALOG, CATALOG_SETS, AGENT_DOMAINS, REVIEWED_BOUNDS } from './authoring/catalog.ts';
export { PAUSE_CONFIRMATION, AUTHORIZATION_METHODS, type VersionRecord, type AuthorizeResult, type ActiveMandate, type PrincipalAuthorization, type AuthorizationMethod } from './authoring/mandate-versioning.ts';
export type { DraftValidation, GuardrailRow } from './authoring/draft-validator.ts';
export { DOMAIN_AGENTS, actionableCandidates, assessCandidate, STATIC_SCOPE_CODES, type CandidateEligibility, type CandidateUniverse, type EligibilityFilter } from './agents/index.ts';
export {
  LIVE_LAB_SETTLEMENT_PROFILE,
  ROBINHOOD_TESTNET_CONNECTOR,
  ROBINHOOD_TESTNET_STOCK_FIXTURES,
  executableCandidates,
  stockFixtureFor,
  type CapabilityStatus,
  type ExecutableUniverse,
  type ExecutionCapability,
  type SettlementProfile,
  type StockFixtureDefinition,
} from './agents/index.ts';
export { POLICY_CASE_IDS, POLICY_CASES, type PolicyCaseId } from './policy-stress/cases.ts';
export { DEFAULT_POLICY_STRESS_ATTEMPTS, MAX_POLICY_STRESS_ATTEMPTS, type PolicyStressResult, type PolicyStressAttempt } from './policy-stress/runner.ts';
export { OpenAIProvider, DEFAULT_OPENAI_MODEL } from './runtime/openai-provider.ts';
export { StubProvider } from './runtime/stub-provider.ts';
export { LatencyChaosProvider, parseChaosSpec, CHAOS_DELAYS_MS } from './runtime/latency-chaos.ts';
export { ProviderError } from './runtime/errors.ts';
export { realClock, type Clock } from './runtime/clock.ts';
export { APPROVAL_CHAIN_ID, sessionDigest } from './wallet/approval.ts';
export { spineAuthority } from './wallet/spine.ts';
export { spineAuthorityV3, spineTypedDataV3, SPINE_V3_CHAIN_ID } from './wallet/spine-v3.ts';
export type { V3ChallengeHost, V3PublicScope, V3IssueInput, V3IssueResult } from './wallet/v3-host.ts';
export type { AgentModelProvider, ProviderKind } from './runtime/provider.ts';
export { LIVE_SCHEMA, LIVE_EVENT_KINDS, type LiveEvent, type LiveEventKind } from './telemetry/events.ts';
export { renderEvent } from './telemetry/render.ts';
export { summarizeRun } from './telemetry/summary.ts';
