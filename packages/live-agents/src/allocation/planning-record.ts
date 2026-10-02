/** Durable, non-authoritative evidence for pre-sign allocation planning. */

import type { InitialAllocationPlan } from '@mandate/portfolio';
import { keccakText } from '../wallet/eip712.ts';
import type { AllocationIntent } from './intent.ts';
import type { AllocationPlan } from './planning.ts';
import type { Role } from '../types.ts';
import { encodeRecord } from '../persistence/codec.ts';

export const PLANNING_RECORD_SCHEMA = 'mandate-planning-record/v1';

export interface AllocationEvidence {
  readonly role: Role;
  readonly atoms: bigint;
  readonly source: 'FIXED' | 'PLANNED';
}

export interface PlanningRecordV1 {
  readonly schema: typeof PLANNING_RECORD_SCHEMA;
  readonly planningId: string;
  readonly sessionId: string;
  readonly mandateVersion: number;
  readonly allocationIntent: AllocationIntent;
  readonly totalCapitalAtoms: bigint;
  readonly enabledAgents: readonly Role[];
  readonly fixedBudgets: readonly AllocationEvidence[];
  readonly dynamicPoolAtoms: bigint;
  readonly opportunityCardDigests: readonly string[];
  readonly jevEvidenceDigest: string | null;
  readonly proposedAllocation: readonly AllocationEvidence[];
  readonly userEditedAllocation: readonly AllocationEvidence[] | null;
  readonly acceptedAllocation: readonly AllocationEvidence[] | null;
  readonly initialAllocation: InitialAllocationPlan | null;
  readonly initialAllocationDigest: string | null;
  readonly autoReallocate: boolean;
  readonly createdAt: bigint;
  readonly acceptedAt: bigint | null;
  readonly freshUntil: bigint;
  readonly status: 'PROPOSED' | 'ACCEPTED' | 'SIGNED' | 'PLAN_STALE';
  /** The structured, user-visible proposal. Model prose remains advisory. */
  readonly proposal: AllocationPlan | null;
}

/** Evidence digest only. It is never used as financial authority. */
export function evidenceDigest(value: object): string {
  return keccakText(encodeRecord(value));
}
