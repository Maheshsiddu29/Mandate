/**
 * ABI encoding for `MandateDelegatedExecutionGate.execute`.
 */

import {
  CANDIDATE,
  MANDATE,
  TERMS,
  address,
  bytes,
  bytes32,
  calldata,
  candidateValue,
  mandateValue,
  termsValue,
  tuple,
  uint,
} from '@mandate/evm-robinhood';
import type { DelegationFields, GateCandidate, GateMandate, GateTerms } from '@mandate/execution-gate';

const DELEGATION = tuple(
  ['portfolioMandateDigest', bytes32],
  ['initialAllocationDigest', bytes32],
  ['sessionDigest', bytes32],
  ['principal', address],
  ['delegate', address],
  ['agent', address],
  ['representationIdHash', bytes32],
  ['fundingToken', address],
  ['cumulativeDebitLimit', uint(256)],
  ['validAfter', uint(64)],
  ['validUntil', uint(64)],
  ['generation', uint(64)],
);

/** Matches Solidity `MandateDelegatedExecutionGate.execute` argument list. */
export const DELEGATED_EXECUTE_SIGNATURE =
  'execute((bytes32,bytes32,bytes32,address,address,address,bytes32,address,uint256,uint64,uint64,uint64),bytes,(uint16,bytes32,uint64,address,address,(string,string,string),uint8,(string,uint8,uint256),(string,uint8,uint256),uint16,uint8,string[],string[],string[],uint64,uint32,uint32,uint8,int64,int64,int64),(uint16,string,(string,string,string),string,string,string,uint8,address,(string,uint8,uint256),(string,string,uint8,uint256),(string,uint8,uint256),(string,uint8,uint256),string,bytes32,bytes32,uint64),(address,uint256,uint64,bytes),bytes,uint64,bytes)';

function delegationValue(d: DelegationFields): { readonly [k: string]: string | bigint } {
  return {
    portfolioMandateDigest: d.portfolioMandateDigest,
    initialAllocationDigest: d.initialAllocationDigest,
    sessionDigest: d.sessionDigest,
    principal: d.principal,
    delegate: d.delegate,
    agent: d.agent,
    representationIdHash: d.representationIdHash,
    fundingToken: d.fundingToken,
    cumulativeDebitLimit: d.cumulativeDebitLimit,
    validAfter: d.validAfter,
    validUntil: d.validUntil,
    generation: d.generation,
  };
}

export function encodeDelegatedExecute(
  delegation: DelegationFields,
  principalSignature: string,
  mandate: GateMandate,
  candidate: GateCandidate,
  terms: GateTerms,
  agentSignature: string,
  executionNonce: bigint,
  delegateSignature: string,
): string {
  return calldata(
    DELEGATED_EXECUTE_SIGNATURE,
    [DELEGATION, bytes, MANDATE, CANDIDATE, TERMS, bytes, uint(64), bytes],
    [
      delegationValue(delegation),
      principalSignature,
      mandateValue(mandate),
      candidateValue(candidate),
      termsValue(terms),
      agentSignature,
      executionNonce,
      delegateSignature,
    ],
  );
}
