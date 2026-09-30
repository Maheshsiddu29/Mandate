/**
 * Frontend view of `MANDATE_JUDGE_DEMO.V1`.
 *
 * These types describe the generated transcript and the view models derived
 * from it. They are presentation data. Nothing here is an authorization.
 */

export type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json };

export interface AmountView {
  readonly resource: string;
  readonly unit: string;
  readonly decimals: number;
  readonly atoms: string;
  readonly amount: string;
}

export interface AgentRef {
  readonly id: string;
  readonly label: string;
}

export interface ReasonView {
  readonly code: string;
  readonly subject: string;
}

export interface ArtifactRef {
  readonly name: string;
  readonly value: string;
}

export interface JudgeDemoEvent {
  readonly schema: string;
  readonly sequence: number;
  readonly scene: number;
  readonly kind: string;
  readonly run: string | null;
  readonly round: number | null;
  readonly protocolTime: string | null;
  readonly agent: AgentRef | null;
  readonly domain: string | null;
  readonly proposal: string | null;
  readonly candidate: string | null;
  readonly requested: readonly AmountView[];
  readonly approved: readonly AmountView[];
  readonly status: string;
  readonly reasons: readonly ReasonView[];
  readonly evidence: string | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly message: string;
  readonly data: { readonly [key: string]: Json };
}

export interface JudgeTranscript {
  readonly schema: string;
  readonly version: number;
  readonly presentationOnly: true;
  readonly events: readonly JudgeDemoEvent[];
  readonly presentationDigest: string;
}

export interface DemoSummary {
  readonly schema: string;
  readonly version: number;
  readonly presentationDigest: string;
  readonly eventCount: number;
  readonly principal: string;
  readonly allocationMode: string;
  readonly mandateDigest: string;
  readonly authority: AmountView;
  readonly agentCount: number;
  readonly initialRequested: AmountView | null;
  readonly admissibleDemand: AmountView | null;
}

export interface DemoEventView {
  readonly sequence: number;
  readonly scene: number;
  readonly kind: string;
  readonly status: string;
  readonly run: string | null;
  readonly round: number | null;
  readonly message: string;
  readonly agentLabel: string | null;
  readonly agentId: string | null;
  readonly reasons: readonly ReasonView[];
  readonly evidence: string | null;
}

export interface AgentView {
  readonly id: string;
  readonly label: string;
  readonly domain: string;
  readonly title: string;
  readonly state: string;
  readonly detail: string;
  readonly inRoom: boolean;
  readonly compromised: boolean;
  readonly revoked: false;
  readonly reasons: readonly ReasonView[];
  readonly requested: AmountView | null;
  readonly reserved: AmountView | null;
}

export interface FactView {
  readonly label: string;
  readonly value: string;
  readonly tone: 'neutral' | 'blocked' | 'ok' | 'warning';
}

export interface BlockedProposalView {
  readonly proposal: string;
  readonly agentId: string;
  readonly agentLabel: string;
  readonly title: string;
  readonly reasons: readonly ReasonView[];
  readonly requested: AmountView | null;
  readonly facts: readonly FactView[];
  readonly lure: string | null;
  readonly inRoom: false;
}

export interface RoomStepView {
  readonly sequence: number;
  readonly round: number;
  readonly kind: string;
  readonly status: string;
  readonly agentLabel: string | null;
  readonly message: string;
  readonly requested: AmountView | null;
  readonly approved: AmountView | null;
  readonly from: string | null;
  readonly reasons: readonly ReasonView[];
  readonly proposal: string | null;
}

export interface RoomRoundView {
  readonly run: string;
  readonly round: number;
  readonly steps: readonly RoomStepView[];
}

export interface RoomView {
  readonly run: string;
  readonly participants: readonly string[];
  readonly excludedProposals: readonly string[];
  readonly rounds: readonly RoomRoundView[];
  readonly proposed: AmountView | null;
  readonly authorized: boolean;
  readonly cannot: readonly string[];
}

export interface CheckView {
  readonly id: string;
  readonly check: string;
  readonly result: string;
}

export interface VerificationView {
  readonly run: string;
  readonly passed: number;
  readonly total: number;
  readonly status: string;
  readonly items: readonly CheckView[];
  readonly awaitingAuthorization: boolean;
}

export interface ForgeryView {
  readonly message: string;
  readonly verdict: string;
  readonly reasons: readonly ReasonView[];
}

export interface AttackView {
  readonly agentId: string;
  readonly agentLabel: string;
  readonly sameIdentity: boolean;
  readonly signatureValid: boolean;
  readonly capability: string;
  readonly action: string;
  readonly reasons: readonly ReasonView[];
  readonly changes: readonly { readonly field: string; readonly expected: string; readonly attempted: string }[];
  readonly reservationsWritten: number;
  readonly attemptsWritten: number;
  readonly executorCalls: number;
  readonly transactions: number;
  readonly verifierRefused: boolean;
}

export interface IsolationReservationView {
  readonly agent: string;
  readonly phase: string;
  readonly execution: string | null;
  readonly evidence: string | null;
}

export interface IsolationView {
  readonly reserved: AmountView | null;
  readonly available: AmountView | null;
  readonly ledgerUnchanged: boolean;
  readonly reservations: readonly IsolationReservationView[];
  readonly agents: readonly { readonly agent: string; readonly compromised: boolean; readonly status: string; readonly headroomUnchanged: boolean }[];
}

export interface CompliantView {
  readonly agentId: string;
  readonly agentLabel: string;
  readonly sameIdentity: boolean;
  readonly requested: AmountView | null;
  readonly reserved: AmountView | null;
  readonly availableAtoms: string | null;
  readonly evidence: string | null;
  readonly integrationEvidence: string | null;
  readonly executionStatus: string | null;
  readonly transactions: number;
  readonly recipient: string | null;
}

export interface PortfolioConflictView {
  readonly agentLabel: string;
  readonly individuallyValid: boolean;
  readonly portfolioValid: boolean;
  readonly screeningCodes: readonly string[];
  readonly requested: AmountView | null;
  readonly headroom: AmountView | null;
  readonly available: AmountView | null;
  readonly target: AmountView | null;
  readonly reasons: readonly ReasonView[];
  readonly reservedAfter: AmountView | null;
  readonly authorized: boolean;
}

export interface ReceiptView {
  readonly run: string;
  readonly digest: string;
  readonly mandateDigest: string;
  readonly transactions: number;
  readonly message: string;
  readonly reserved: AmountView | null;
}

export interface EvidenceView {
  readonly domain: string;
  readonly title: string;
  readonly integration: string;
  readonly integrationEvidence: string;
  readonly thisRun: readonly string[];
  readonly historicalLive: boolean;
  readonly chainName: string | null;
  readonly chainId: string | null;
  readonly gate: string | null;
  readonly explorer: string | null;
  readonly buyAction: string | null;
  readonly buyQuantity: string | null;
  readonly buyGas: string | null;
  readonly buyTransaction: string | null;
  readonly replayRevert: string | null;
  readonly mutationRevert: string | null;
  readonly overBudgetTransactions: number | null;
}

export interface ResourceSnapshot {
  readonly requested: AmountView | null;
  readonly authority: AmountView | null;
  readonly proposed: AmountView | null;
  readonly reserved: AmountView | null;
  readonly available: AmountView | null;
}

export interface Presentation {
  readonly scene: number;
  readonly sceneTitle: string;
  readonly position: number;
  readonly eventCount: number;
  readonly latest: DemoEventView | null;
  readonly recent: readonly DemoEventView[];
  readonly summary: DemoSummary;
  readonly resources: ResourceSnapshot;
  readonly agents: readonly AgentView[];
  readonly blocked: readonly BlockedProposalView[];
  readonly admissible: readonly { readonly agentLabel: string; readonly requested: AmountView | null; readonly conflict: boolean }[];
  readonly conflictOpen: boolean;
  readonly room: RoomView | null;
  readonly verification: VerificationView | null;
  readonly forgery: ForgeryView | null;
  readonly attack: AttackView | null;
  readonly isolation: IsolationView | null;
  readonly compliant: CompliantView | null;
  readonly portfolioConflict: PortfolioConflictView | null;
  readonly receipts: readonly ReceiptView[];
  readonly evidence: readonly EvidenceView[];
  readonly securityInvalidCount: number;
  readonly adjustmentCount: number;
  readonly maliciousTransactions: number;
  readonly reservedChildren: number | null;
  readonly firstReserved: AmountView | null;
  readonly compliantReserved: AmountView | null;
}

export interface MandateDemoProvider {
  getSummary(): Promise<DemoSummary>;
  getEvents(): Promise<readonly DemoEventView[]>;
  getAgents(): Promise<readonly AgentView[]>;
  getRoomRounds(): Promise<readonly RoomRoundView[]>;
  getReceipts(): Promise<readonly ReceiptView[]>;
  getEvidence(): Promise<readonly EvidenceView[]>;
}
