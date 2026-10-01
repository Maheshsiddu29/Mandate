/**
 * Per-execution gate authority for a V2 wallet that is not the gitignored
 * manifest principal (docs/demo/authority-spine-v2.md).
 *
 * The frozen Phase 6 gate recovers `MandateAuthorization(bytes32 mandateDigest)`
 * under `{Mandate, 1, chainId, verifyingContract = gate}` and requires the
 * signer to be `mandate.principal`. It has no ERC-1271 and no session keys.
 * The PortfolioMandateV2 signature is a different EIP-712 message, with no
 * verifying contract, so it cannot be replayed as this one.
 *
 * This module does not hold a key. It describes the exact typed data the
 * wallet must sign, and it accepts a signature only when that signature
 * recovers to the wallet for the artifact the domain leg derived. The 7E.3
 * agent key still signs the execution commitment. The deployer key still
 * pays gas. Neither is this wallet.
 */

import { bytesToHex, domainSeparator, eip712SigningHash, type Bytes32 } from '@mandate/kernel';
import type { AuthorizationRecord } from '@mandate/control';
import type { AttemptRecord, LedgerState } from '@mandate/ledger';
import { recoverSigner } from '@mandate/execution-gate';
import {
  buildGateArtifact,
  slotScope,
  verifyAdmitted,
  type Address,
  type ArtifactTerms,
  type CustodyBinding,
  type CustodyResult,
  type CustodyView,
  type GateArtifact,
  type GateClaim,
  type GateKeyCustody,
  type ReviewedGate,
  type ReviewedMarket,
} from '@mandate/evm-robinhood';

/** Same width the 7E.3 signer uses. The deadline is not inside the mandate digest. */
const ATTEMPT_DEADLINE_SECONDS = 90n;

const SIG = /^0x[0-9a-f]{130}$/;

export const GATE_EXECUTION_NOTE =
  'EIP-712 MandateAuthorization under the deployed MandateExecutionGate (domain Mandate version 1, chain 46630, verifyingContract = the gate). This is the per-execution principal signature. It is not the PortfolioMandateV2 signature. The 7E.3 agent key still signs the execution commitment. The gitignored deployer key still pays gas. One signature authorizes this mandate digest only.';

export interface GateExecutionRequest {
  readonly kind: 'MANDATE_AUTHORIZATION';
  readonly principal: string;
  readonly agent: string;
  readonly gate: string;
  readonly chainId: string;
  readonly mandateDigest: string;
  readonly signingHash: string;
  /** Mandate expiry (`expiresAt`), which is inside the signed digest. Not the 90s execution deadline. */
  readonly mandateExpiresAt: string;
  readonly debitAtoms: string;
  readonly quantityAtoms: string;
  readonly note: string;
  /** `eth_signTypedData_v4` payload. `chainId` is a number so a wallet encodes it as uint256. */
  readonly typedData: { readonly [k: string]: unknown };
}

export type GateExecutionDecision =
  | { readonly ok: true; readonly signature: string }
  | { readonly ok: false; readonly reason: 'GATE_EXECUTION_AUTHORITY_REQUIRED' | 'GATE_EXECUTION_SIGNATURE_INVALID' | 'GATE_EXECUTION_SIGNER_MISMATCH' };

export interface GateExecutionFacts {
  readonly record: AuthorizationRecord;
  readonly state: LedgerState;
  readonly gate: ReviewedGate;
  readonly market: ReviewedMarket;
  readonly principal: Address;
  readonly agent: Address;
  readonly quantity: bigint;
  /** The manifest's `domainSeparator()`. A derived domain that differs is refused. */
  readonly domainSeparator: string;
}

/**
 * The next gate slot for this principal. Matches `nextSlot` in the Robinhood
 * signer: one past the highest sequence this ledger has admitted in `scope`.
 */
function nextNonce(state: LedgerState, scope: string): bigint {
  let high = 0n;
  for (const attempt of state.attempts.values() as readonly AttemptRecord[]) {
    const slot = attempt.slot;
    if (slot !== null && slot.scope === scope && slot.sequence > high) high = slot.sequence;
  }
  return high + 1n;
}

/**
 * The gate mandate this domain authorization will issue, and the typed data
 * the wallet signs. The execution deadline is chosen later, at issue, and is
 * not part of `MandateAuthorization` — only the agent signs it. Rebuilding
 * with the same record, slot and principal yields the same mandate digest.
 */
export function describeGateExecution(f: GateExecutionFacts): { readonly ok: true; readonly value: GateExecutionRequest } | { readonly ok: false; readonly reason: string } {
  if (f.record.principal.kind !== 'eip155-address' || f.record.principal.value !== f.principal) return { ok: false, reason: 'GATE_EXECUTION_PRINCIPAL_MISMATCH' };
  const ceiling = f.record.validUntil - 1n;
  const proposed = f.record.evaluatedAt + ATTEMPT_DEADLINE_SECONDS;
  const deadline = proposed < ceiling ? proposed : ceiling;
  if (deadline < f.record.evaluatedAt) return { ok: false, reason: 'GATE_EXECUTION_DEADLINE_UNUSABLE' };
  const terms: ArtifactTerms = { gate: f.gate, market: f.market, principal: f.principal, agent: f.agent, quantity: f.quantity, nonce: nextNonce(f.state, slotScope(f.gate.chainId, f.gate.gate, f.principal)), deadline };
  const artifact = buildGateArtifact(
    {
      executionId: f.record.executionId,
      authorizationId: f.record.id,
      reservation: f.record.reservation,
      generation: f.record.generation,
      adapter: f.record.adapter,
      evaluatedAt: f.record.evaluatedAt,
      validUntil: f.record.validUntil,
    },
    terms,
  );
  if (bytesToHex(domainSeparator(artifact.domain)) !== f.domainSeparator) return { ok: false, reason: 'GATE_DOMAIN_SEPARATOR_MISMATCH' };
  const signingHash = bytesToHex(eip712SigningHash(artifact.domain, artifact.mandateDigest));
  const chainId = f.gate.chainId;
  return {
    ok: true,
    value: {
      kind: 'MANDATE_AUTHORIZATION',
      principal: f.principal,
      agent: f.agent,
      gate: f.gate.gate,
      chainId: chainId.toString(),
      mandateDigest: artifact.mandateDigest,
      signingHash,
      mandateExpiresAt: f.record.validUntil.toString(),
      debitAtoms: artifact.mandate.economicLimit.atoms.toString(),
      quantityAtoms: f.quantity.toString(),
      note: GATE_EXECUTION_NOTE,
      typedData: {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          MandateAuthorization: [{ name: 'mandateDigest', type: 'bytes32' }],
        },
        primaryType: 'MandateAuthorization',
        domain: { name: 'Mandate', version: '1', chainId: Number(chainId), verifyingContract: f.gate.gate },
        message: { mandateDigest: artifact.mandateDigest },
      },
    },
  };
}

/** Whether `signature` is this wallet's EIP-712 signature over `request.signingHash`. */
export function acceptGateExecution(request: GateExecutionRequest, signature: string | null, principal: string): GateExecutionDecision {
  if (signature === null || signature.trim() === '') return { ok: false, reason: 'GATE_EXECUTION_AUTHORITY_REQUIRED' };
  const normalized = signature.trim().toLowerCase();
  if (!SIG.test(normalized)) return { ok: false, reason: 'GATE_EXECUTION_SIGNATURE_INVALID' };
  const recovered = recoverSigner(eip712SigningHash(requestDomain(request), request.mandateDigest as Bytes32), normalized);
  if (recovered === undefined) return { ok: false, reason: 'GATE_EXECUTION_SIGNATURE_INVALID' };
  if (recovered !== principal.toLowerCase() || recovered !== request.principal.toLowerCase()) return { ok: false, reason: 'GATE_EXECUTION_SIGNER_MISMATCH' };
  return { ok: true, signature: normalized };
}

function requestDomain(request: GateExecutionRequest): { readonly name: 'Mandate'; readonly version: '1'; readonly chainId: bigint; readonly verifyingContract: string } {
  return { name: 'Mandate', version: '1', chainId: BigInt(request.chainId), verifyingContract: request.gate };
}

/**
 * Custody that attaches a wallet-presented gate signature. It has no private
 * key. `signMandate` returns the signature only after the same admission
 * check the key custody performs, and only when the signature recovers to
 * this principal under the gate's own hash.
 */
export class PresentedGateCustody implements GateKeyCustody {
  readonly #principal: Address;
  readonly #view: CustodyView;
  readonly #binding: CustodyBinding;
  #signature: string | null = null;

  constructor(principal: Address, view: CustodyView, binding: CustodyBinding) {
    this.#principal = principal;
    this.#view = view;
    this.#binding = binding;
  }

  principal(): Address {
    return this.#principal;
  }

  /** The signature the wallet produced for the described mandate. Replaces any previous one. */
  present(signature: string): void {
    this.#signature = signature;
  }

  signMandate(artifact: GateArtifact, terms: ArtifactTerms, claim: GateClaim): CustodyResult<string> {
    if (this.#signature === null) return { ok: false, error: 'GATE_EXECUTION_AUTHORITY_REQUIRED' };
    const refusal = verifyAdmitted(this.#view, this.#binding, this.#principal, artifact, terms, claim);
    if (refusal !== null) return { ok: false, error: refusal };
    const recovered = recoverSigner(eip712SigningHash(artifact.domain, artifact.mandateDigest), this.#signature);
    if (recovered !== this.#principal) return { ok: false, error: 'GATE_EXECUTION_SIGNATURE_INVALID' };
    return { ok: true, value: this.#signature };
  }
}
