/**
 * Domain-separated commitments over the advisory decision.
 *
 * These digests are audit commitments, not authentication and not
 * authorization. They exist so a recorded advisory decision names exactly which
 * closed set the advice was given over: a receipt that merely said "Jev chose
 * route B" would not be attributable once the inputs were gone.
 *
 * The tags are distinct from every kernel, registry and router tag, so a Jev
 * commitment can never be mistaken for one of theirs.
 */

import { ByteWriter, bytes32ToBytes, keccak256, type Bytes32 } from '@mandate/kernel';
import type { ClosedChoiceSet } from './choices.ts';
import type { JevAssistedSelectionReceipt, JevCandidateView, JevDecisionReceipt, JevState } from './types.ts';

const CHOICE_SET_DOMAIN = 'MANDATE.JEV.CHOICESET.V1';
const STATE_DOMAIN = 'MANDATE.JEV.STATE.V1';
const RECEIPT_DOMAIN = 'MANDATE.JEV.RECEIPT.V1';
const SELECTION_DOMAIN = 'MANDATE.JEV.SELECTION.V1';

/**
 * Probabilities are floats from an external service and must not reach a digest
 * as floats. They are committed at fixed precision, which is enough to
 * reproduce the recorded value and never enough to depend on float equality.
 */
const PROBABILITY_SCALE = 1_000_000n;

function scaled(value: number): bigint {
  return BigInt(Math.round(value * Number(PROBABILITY_SCALE)));
}

function writeView(writer: ByteWriter, view: JevCandidateView): void {
  writer.str(view.choiceId).str(view.allInCostAtoms).str(view.costUnit).u8(view.costDecimals);
  writer.str(view.explicitFeeTotalAtoms).str(view.executionDeviationBps).str(view.quoteAgeSeconds);
  writer.u8(view.routeStepCount).str(view.providerClass).str(view.venueReliability);
  writer.str(view.quoteFirmness).str(view.fillPolicy);
}

/**
 * Commit to the closed set: the choice identifiers and, crucially, the routing
 * candidate digests they resolve to. Without the digests the identifiers are
 * meaningless labels and the receipt would not pin what was actually offered.
 */
export function closedChoiceSetDigest(set: ClosedChoiceSet): Bytes32 {
  const writer = new ByteWriter().tag(CHOICE_SET_DOMAIN).u16(set.candidateIds.length);
  for (let index = 0; index < set.candidateIds.length; index += 1) {
    writer.str(set.candidateIds[index] as string);
    writer.bytes32(bytes32ToBytes((set.routes[index] as ClosedChoiceSet['routes'][number]).candidate.candidateDigest));
  }
  return keccak256(writer.finish());
}

export function jevStateDigest(state: JevState): Bytes32 {
  const writer = new ByteWriter().tag(STATE_DOMAIN).str(state.schema).str(state.side);
  writer.str(state.costUnit).u8(state.costDecimals).u16(state.candidateCount);
  for (const view of state.candidates) writeView(writer, view);
  return keccak256(writer.finish());
}

export function encodeJevDecisionReceipt(receipt: Omit<JevDecisionReceipt, 'receiptDigest'>): Uint8Array {
  const writer = new ByteWriter().tag(RECEIPT_DOMAIN).u16(receipt.version);
  writer.str(receipt.integrationVersion).u16(receipt.questionSchemaVersion);
  writer.bytes32(bytes32ToBytes(receipt.closedCandidateSetDigest));
  writer.u16(receipt.candidateIds.length);
  for (const id of receipt.candidateIds) writer.str(id);
  writer.u16(receipt.candidateDigests.length);
  for (const digest of receipt.candidateDigests) writer.bytes32(bytes32ToBytes(digest));
  writer.bytes32(bytes32ToBytes(receipt.stateDigest));
  writer.str(receipt.modelRequested);
  optionalString(writer, receipt.modelReturned);
  optionalString(writer, receipt.selectedChoice);
  optionalScaled(writer, receipt.confidence);
  writer.u16(receipt.probabilities.length);
  for (const [name, value] of receipt.probabilities) writer.str(name).u64(scaled(value));
  optionalCount(writer, receipt.inputTokens);
  optionalCount(writer, receipt.outputTokens);
  optionalCount(writer, receipt.latencyMs);
  writer.str(receipt.outcome).str(receipt.selectionMode);
  optionalString(writer, receipt.fallbackReason);
  writer.i64(receipt.evaluatedAtUnixSeconds);
  return writer.finish();
}

export function jevDecisionReceiptDigest(receipt: Omit<JevDecisionReceipt, 'receiptDigest'>): Bytes32 {
  return keccak256(encodeJevDecisionReceipt(receipt));
}

export function encodeJevSelectionReceipt(receipt: Omit<JevAssistedSelectionReceipt, 'receiptDigest'>): Uint8Array {
  const writer = new ByteWriter().tag(SELECTION_DOMAIN).u16(receipt.version);
  writer.str(receipt.integrationVersion).str(receipt.selectionMode);
  writer.bytes32(bytes32ToBytes(receipt.routingReceiptDigest));
  optionalDigest(writer, receipt.jevReceiptDigest);
  optionalDigest(writer, receipt.deterministicCandidateDigest);
  optionalDigest(writer, receipt.selectedCandidateDigest);
  optionalDigest(writer, receipt.handoffVerificationReceiptDigest);
  writer.str(receipt.handoffDecision).i64(receipt.evaluatedAtUnixSeconds);
  return writer.finish();
}

export function jevSelectionReceiptDigest(receipt: Omit<JevAssistedSelectionReceipt, 'receiptDigest'>): Bytes32 {
  return keccak256(encodeJevSelectionReceipt(receipt));
}

function optionalDigest(writer: ByteWriter, value: Bytes32 | null): void {
  if (value === null) writer.u8(0);
  else writer.u8(1).bytes32(bytes32ToBytes(value));
}

function optionalString(writer: ByteWriter, value: string | null): void {
  if (value === null) writer.u8(0);
  else writer.u8(1).str(value);
}

function optionalScaled(writer: ByteWriter, value: number | null): void {
  if (value === null) writer.u8(0);
  else writer.u8(1).u64(scaled(value));
}

function optionalCount(writer: ByteWriter, value: number | null): void {
  if (value === null) writer.u8(0);
  else writer.u8(1).u64(BigInt(value));
}
