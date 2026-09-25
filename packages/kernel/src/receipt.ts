/**
 * Verification receipts (design section 15).
 *
 * Every decision produces one, PASS and REJECT alike: a refusal that leaves no
 * record is not auditable, and refusals are the product.
 *
 * The explainability requirement (INV-11) is stronger than logging. A receipt
 * carries digests of the exact inputs the verdict was computed over, so a
 * recorded decision can be re-run and must produce the same verdict. A receipt
 * whose verdict is not reproducible from its inputs indicates either a
 * non-deterministic verifier or an incomplete receipt; both are defects.
 *
 * Receipts contain no secrets. They carry digests and identifiers, never
 * signing material, and `detail` values are bounded machine-readable strings
 * rather than free text.
 */

import { keccak256 } from './encoding/digest.ts';
import { ByteWriter } from './encoding/writer.ts';
import { DomainTag } from './encoding/codec.ts';
import { bytes32ToBytes, type Bytes32 } from './bytes.ts';
import type { ReasonCodeName } from './reason-codes.ts';
import type { Violation } from './verifier/checks.ts';

export const VERIFIER_VERSION = 'mandate-kernel/2';

export const Decision = { PASS: 'PASS', REJECT: 'REJECT' } as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

export interface VerificationReceipt {
  readonly verifierVersion: string;
  /** Null when the corresponding input did not parse and so has no canonical encoding. */
  readonly mandateDigest: Bytes32 | null;
  readonly candidateDigest: Bytes32 | null;
  readonly trustedStateDigest: Bytes32 | null;
  readonly evaluatedAtUnixSeconds: bigint | null;

  readonly decision: Decision;
  /** Sorted, deduplicated. The order never depends on the order checks ran in. */
  readonly reasonCodes: readonly ReasonCodeName[];
  readonly violations: readonly Violation[];

  /** Digest over everything above. A stable commitment for logs and audit; not authentication. */
  readonly receiptDigest: Bytes32;
}

const ABSENT = 0;
const PRESENT = 1;

function writeOptionalDigest(w: ByteWriter, d: Bytes32 | null): void {
  if (d === null) w.u8(ABSENT);
  else w.u8(PRESENT).bytes32(bytes32ToBytes(d));
}

/**
 * Canonically encode a receipt so its digest is stable.
 *
 * Violation details are sorted by key, because an object's own key order is an
 * accident of construction and must not reach a digest.
 */
export function encodeReceipt(r: Omit<VerificationReceipt, 'receiptDigest'>): Uint8Array {
  const w = new ByteWriter();
  w.tag(DomainTag.RECEIPT).u16(1);
  w.str(r.verifierVersion);
  writeOptionalDigest(w, r.mandateDigest);
  writeOptionalDigest(w, r.candidateDigest);
  writeOptionalDigest(w, r.trustedStateDigest);
  if (r.evaluatedAtUnixSeconds === null) w.u8(ABSENT);
  else w.u8(PRESENT).i64(r.evaluatedAtUnixSeconds);
  w.str(r.decision);
  w.u16(r.violations.length);
  for (const v of r.violations) {
    w.str(v.code);
    const keys = Object.keys(v.detail).sort();
    w.u16(keys.length);
    for (const k of keys) w.str(k).str(v.detail[k] as string);
  }
  return w.finish();
}

export function receiptDigest(r: Omit<VerificationReceipt, 'receiptDigest'>): Bytes32 {
  return keccak256(encodeReceipt(r));
}
