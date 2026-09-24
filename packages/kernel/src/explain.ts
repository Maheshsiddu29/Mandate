/**
 * The human-readable layer, kept deliberately separate from the verifier.
 *
 * Mandate's UX principle is: simple on the surface, extremely strict
 * underneath. A user should see
 *
 *     Trade blocked
 *     The selected asset does not match your authorization.
 *
 * while a developer or auditor still gets `CANONICAL_ASSET_MISMATCH`, the
 * expected and observed values, the evaluation time and the receipt digest.
 *
 * This module is the surface. The verifier returns machine codes and data and
 * never a rendered string, so this rendering can be replaced, localized or
 * moved to a frontend without touching anything that makes a safety decision.
 */

import { reasonCode, type ReasonCodeName } from './reason-codes.ts';
import { Decision, type VerificationReceipt } from './receipt.ts';

export interface ExplainedViolation {
  readonly code: ReasonCodeName;
  readonly id: string;
  readonly family: string;
  readonly enforcementPoint: string;
  /** Safe to show an end user. Contains no identifiers, addresses or internal structure. */
  readonly humanMessage: string;
  /** For developers and auditors. */
  readonly developerMessage: string;
  readonly detail: Readonly<Record<string, string>>;
}

export interface ExplainedReceipt {
  readonly decision: Decision;
  /** One short line for a user. */
  readonly headline: string;
  /** User-facing reasons, deduplicated, in receipt order. */
  readonly userMessages: readonly string[];
  readonly violations: readonly ExplainedViolation[];
  readonly receiptDigest: string;
  readonly evaluatedAtUnixSeconds: bigint | null;
}

export function explain(receipt: VerificationReceipt): ExplainedReceipt {
  const violations = receipt.violations.map((v) => {
    const def = reasonCode(v.code);
    return {
      code: v.code,
      id: def.id,
      family: def.family,
      enforcementPoint: def.enforcementPoint,
      humanMessage: def.humanMessage,
      developerMessage: def.developerMessage,
      detail: v.detail,
    };
  });

  return {
    decision: receipt.decision,
    headline: receipt.decision === Decision.PASS ? 'Trade authorized' : 'Trade blocked',
    userMessages: [...new Set(violations.map((v) => v.humanMessage))],
    violations,
    receiptDigest: receipt.receiptDigest,
    evaluatedAtUnixSeconds: receipt.evaluatedAtUnixSeconds,
  };
}
