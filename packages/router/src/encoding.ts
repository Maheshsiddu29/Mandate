import {
  ByteWriter, bytes32ToBytes, candidateDigest as kernelCandidateDigest,
  keccak256, type Amount, type Bytes32, type Price,
} from '@mandate/kernel';
import type { RouteOutcome, RouteQuality, RoutingCandidate, RoutingReceipt } from './types.ts';

const CANDIDATE_DOMAIN = 'MANDATE.ROUTING.CANDIDATE.V1';
const RECEIPT_DOMAIN = 'MANDATE.ROUTING.RECEIPT.V1';

function amount(writer: ByteWriter, value: Amount): void { writer.str(value.unit).u8(value.decimals).u256(value.atoms); }
function price(writer: ByteWriter, value: Price): void { writer.str(value.numeratorUnit).str(value.denominatorUnit).u8(value.decimals).u256(value.atoms); }

export function encodeRoutingCandidate(candidate: Omit<RoutingCandidate, 'candidateDigest' | 'kernelCandidateDigest'>): Uint8Array {
  const writer = new ByteWriter().tag(CANDIDATE_DOMAIN).u16(candidate.version);
  writer.raw(bytes32ToBytes(kernelCandidateDigest(candidate.executionCandidate)));
  writer.str(candidate.routeId).str(candidate.providerId).str(candidate.providerClass).str(candidate.fillPolicy);
  writer.i64(candidate.quoteObservedAtUnixSeconds).i64(candidate.referenceObservedAtUnixSeconds);
  price(writer, candidate.referencePrice);
  amount(writer, candidate.costs.venueFee); amount(writer, candidate.costs.executionFee);
  amount(writer, candidate.costs.settlementFee); amount(writer, candidate.costs.routeFee);
  writer.u8(candidate.steps.length);
  for (const step of candidate.steps) writer.str(step.kind).str(step.venue).str(step.chain).str(step.representationId);
  return writer.finish();
}

export function routingCandidateDigest(candidate: Omit<RoutingCandidate, 'candidateDigest' | 'kernelCandidateDigest'>): Bytes32 {
  return keccak256(encodeRoutingCandidate(candidate));
}

function quality(writer: ByteWriter, value: RouteQuality): void {
  amount(writer, value.economicValue);
  writer.u256(value.executionDeviationBps).u64(value.quoteAgeSeconds).u8(value.routeSteps);
  amount(writer, value.explicitFeeTotal);
}

function outcome(writer: ByteWriter, value: RouteOutcome): void {
  writer.str(value.routeId).str(value.status);
  if (value.candidateDigest === null) writer.u8(0); else writer.u8(1).bytes32(bytes32ToBytes(value.candidateDigest));
  if (value.status === 'ADMISSIBLE') {
    writer.bytes32(bytes32ToBytes(value.verificationReceipt.receiptDigest)); quality(writer, value.quality); return;
  }
  const exclusions = [...value.exclusions].sort((left, right) => {
    const a = `${left.code}:${Object.entries(left.detail).sort().map(([k, v]) => `${k}=${v}`).join('|')}`;
    const b = `${right.code}:${Object.entries(right.detail).sort().map(([k, v]) => `${k}=${v}`).join('|')}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  writer.u16(exclusions.length);
  for (const exclusion of exclusions) {
    writer.str(exclusion.code);
    const entries = Object.entries(exclusion.detail).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    writer.u8(entries.length);
    for (const [key, entry] of entries) writer.str(key).str(entry);
  }
  if (value.verificationReceipt === null) writer.u8(0); else writer.u8(1).bytes32(bytes32ToBytes(value.verificationReceipt.receiptDigest));
}

export function encodeRoutingReceipt(receipt: Omit<RoutingReceipt, 'receiptDigest'>): Uint8Array {
  const writer = new ByteWriter().tag(RECEIPT_DOMAIN).u16(receipt.version).str(receipt.routerVersion);
  writer.bytes32(bytes32ToBytes(receipt.mandateDigest)).bytes32(bytes32ToBytes(receipt.registrySnapshotDigest));
  writer.bytes32(bytes32ToBytes(receipt.marketStateDigest)).i64(receipt.evaluatedAtUnixSeconds);
  writer.u16(receipt.outcomes.length);
  for (const item of receipt.outcomes) outcome(writer, item);
  writer.u16(receipt.rankedCandidateDigests.length);
  for (const digest of receipt.rankedCandidateDigests) writer.bytes32(bytes32ToBytes(digest));
  if (receipt.selectedCandidateDigest === null) writer.u8(0); else writer.u8(1).bytes32(bytes32ToBytes(receipt.selectedCandidateDigest));
  if (receipt.finalVerificationReceiptDigest === null) writer.u8(0); else writer.u8(1).bytes32(bytes32ToBytes(receipt.finalVerificationReceiptDigest));
  return writer.finish();
}

export function routingReceiptDigest(receipt: Omit<RoutingReceipt, 'receiptDigest'>): Bytes32 {
  return keccak256(encodeRoutingReceipt(receipt));
}

