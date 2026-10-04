/**
 * Ephemeral Mandate execution delegate (C2.3). Memory-only private key.
 * Also holds the tiny helper that signs agent ExecutionAuthorization under
 * the V3 gate domain (version "3") — same package boundary as other keys.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@mandate/kernel';
import {
  delegatedExecutionApprovalHash,
  eip712Hash,
  executionCommitment,
  type DelegatedExecutionApprovalFields,
  type GateCandidate,
  type GateMandate,
  type GateTerms,
} from '@mandate/execution-gate';

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Opaque token only the verified settlement path can construct. */
export class VerifiedDelegatedExecution {
  readonly #fields: DelegatedExecutionApprovalFields;
  readonly #chainId: bigint;
  readonly #gate: string;

  private constructor(chainId: bigint, gate: string, fields: DelegatedExecutionApprovalFields) {
    this.#chainId = chainId;
    this.#gate = gate;
    this.#fields = fields;
  }

  static create(input: {
    readonly chainId: bigint;
    readonly gate: string;
    readonly fields: DelegatedExecutionApprovalFields;
  }): VerifiedDelegatedExecution | null {
    if (input.chainId !== 46_630n) return null;
    if (!ADDRESS.test(input.gate) || !ADDRESS.test(input.fields.recipient)) return null;
    if (input.fields.fundingLimit <= 0n || input.fields.deadline === 0n) return null;
    return new VerifiedDelegatedExecution(input.chainId, input.gate, input.fields);
  }

  get fields(): DelegatedExecutionApprovalFields {
    return this.#fields;
  }

  get chainId(): bigint {
    return this.#chainId;
  }

  get gate(): string {
    return this.#gate;
  }
}

export interface ExecutionDelegatePublic {
  readonly address: string;
}

export interface ExecutionDelegate {
  readonly public: ExecutionDelegatePublic;
  signDelegatedExecution(artifact: VerifiedDelegatedExecution): string;
  readonly canSign: boolean;
}

function ethAddress(privateKey: Uint8Array): string {
  const pub = secp256k1.getPublicKey(privateKey, false);
  return bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
}

export function createExecutionDelegate(): ExecutionDelegate {
  const privateKey = secp256k1.utils.randomSecretKey();
  const address = ethAddress(privateKey);
  return {
    public: { address },
    canSign: true,
    signDelegatedExecution(artifact: VerifiedDelegatedExecution): string {
      if (!(artifact instanceof VerifiedDelegatedExecution)) throw new Error('UNVERIFIED_ARTIFACT');
      const hash = delegatedExecutionApprovalHash(artifact.chainId, artifact.gate, artifact.fields);
      const sig = secp256k1.sign(hash, privateKey, { prehash: false, format: 'recovered', lowS: true });
      const out = new Uint8Array(65);
      out.set(sig.subarray(1), 0);
      out[64] = (sig[0] as number) + 27;
      return bytesToHex(out);
    },
  };
}

/** Evidence-only: address known, signing impossible. Key is never regenerated. */
export function restoredExecutionDelegate(address: string): ExecutionDelegate {
  if (!ADDRESS.test(address)) throw new Error('INVALID_DELEGATE_ADDRESS');
  return {
    public: { address },
    canSign: false,
    signDelegatedExecution() {
      throw new Error('DELEGATE_KEY_UNAVAILABLE');
    },
  };
}

function signPrehashed(hash: Uint8Array, privateKey: string): string {
  const key = hexToBytes(privateKey);
  if (key === undefined || key.length !== 32) throw new Error('INVALID_AGENT_KEY');
  const sig = secp256k1.sign(hash, key, { prehash: false, format: 'recovered', lowS: true });
  const out = new Uint8Array(65);
  out.set(sig.subarray(1), 0);
  out[64] = (sig[0] as number) + 27;
  return bytesToHex(out);
}

/** Agent `ExecutionAuthorization` under the V3 gate domain (version "3"). */
export function signV3AgentExecution(
  privateKey: string,
  chainId: bigint,
  gate: string,
  mandate: GateMandate,
  candidate: GateCandidate,
  terms: GateTerms,
  mandateDigest: string,
  candidateDigest: string,
): string {
  const commitment = executionCommitment({
    mandateDigest: mandateDigest as never,
    candidateDigest: candidateDigest as never,
    terms,
  });
  const hash = eip712Hash({ name: 'Mandate', version: '3', chainId, verifyingContract: gate }, commitment);
  void mandate;
  void candidate;
  return signPrehashed(hash, privateKey);
}
