/**
 * `@mandate/sdk` — thin developer facade over the existing Mandate
 * authorization boundary.
 *
 * Mandate isn't only the demo application. External agents integrate the
 * same compile → review → authorize → screen → reserve path through this
 * package. No second authority implementation; no surprise broadcasts;
 * no private principal keys.
 *
 * ```text
 * Agents propose. Mandate authorizes. Markets settle.
 *
 * A valid agent signature proves who proposed an action.
 * It does not prove the action is authorized.
 * ```
 */

export { createMandateClient, liveLabDomainBindings, type MandateClient } from './client.ts';
export { reviewMandateDraft, type ReviewInput } from './review.ts';
export { createV3SettlementBackend, type V3SettlementAdapterConfig } from './settlement.ts';
export type {
  AcceptAuthorizationResult,
  AuthorityContext,
  AuthorizationDecision,
  AuthorizedDecision,
  CompileRequest,
  EvidenceClass,
  MandateClientConfig,
  MandateDraft,
  MandateDraftBundle,
  MandateReview,
  PrepareAuthorizationResult,
  PreparedDelegatedAuthorization,
  PreparedExecution,
  PrepareExecutionResult,
  ReconciliationResult,
  RefusedDecision,
  ReservationResult,
  ReviewBlocker,
  ReviewIssue,
  ScreenRequest,
  SettlementBackend,
} from './types.ts';
