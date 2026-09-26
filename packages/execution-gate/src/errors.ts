/**
 * The gate's refusal vocabulary, as Solidity custom errors.
 *
 * Every name here is a custom error in `MandateExecutionGate.sol` with exactly
 * this signature. The reference model returns these, and the differential test
 * compares the *revert data* — selector and arguments — byte for byte, so a
 * renamed error, a reordered check or a changed argument is a disagreement.
 *
 * `structure.test.ts` asserts this list and the contract's declared errors are
 * the same set.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@mandate/kernel';

const utf8 = new TextEncoder();

export const GATE_ERRORS = {
  WrongChain: [],
  ExecutionProfileExceeded: [],
  UnsupportedMandateVersion: [],
  MalformedMandate: [],
  PrincipalSignatureInvalid: [],
  MalformedCandidate: [],
  UnsupportedRepresentation: [],
  AgentSignatureInvalid: [],
  MandateNotYetActive: [],
  MandateExpired: [],
  ExecutionDeadlinePassed: [],
  MandateAlreadyConsumed: [],
  AgentMismatch: [],
  SideMismatch: [],
  CanonicalAssetMismatch: [],
  RepresentationAssetMismatch: [],
  ChainMismatch: [],
  ChainNotAllowed: [],
  VenueMismatch: [],
  VenueNotAllowed: [],
  IssuerMismatch: [],
  IssuerNotAllowed: [],
  SyntheticNotAllowed: [],
  QuantityUnitMismatch: [],
  ZeroQuantity: [],
  SettlementUnitMismatch: [],
  EconomicUnitMismatch: [],
  FixturePriceMismatch: [],
  NotionalOutOfRange: [],
  NotionalInconsistent: ['uint256', 'uint256', 'uint256'],
  MaxNotionalExceeded: [],
  DeclaredEconomicValueOutOfRange: [],
  DeclaredTotalDebitExceeded: [],
  DeclaredFeesExceedNotional: [],
  DeclaredTotalCreditBelowMinimum: [],
  RecipientNotPrincipal: [],
  FundingLimitExceedsMandate: ['uint256', 'uint256'],
  FundingLimitBelowMandate: ['uint256', 'uint256'],
  TokenDecimalsChanged: ['address'],
  DebitExceedsLimit: ['uint256', 'uint256'],
  CreditBelowMinimum: ['uint256', 'uint256'],
  DebitNotExact: ['uint256', 'uint256'],
  CreditNotExact: ['uint256', 'uint256'],
  // Constructor-only.
  InvalidMarket: [],
  RealMarketStateSourceRequired: [],
} as const satisfies Record<string, readonly ('uint256' | 'address')[]>;

export type GateErrorName = keyof typeof GATE_ERRORS;

export interface GateRejection {
  readonly error: GateErrorName;
  readonly args: readonly bigint[];
}

export function reject(error: GateErrorName, ...args: bigint[]): { readonly ok: false; readonly rejection: GateRejection } {
  return { ok: false, rejection: { error, args } };
}

export function errorSignature(name: string, argTypes: readonly string[]): string {
  return `${name}(${argTypes.join(',')})`;
}

export function selectorOf(signature: string): string {
  return bytesToHex(keccak_256(utf8.encode(signature)).subarray(0, 4));
}

function word(value: bigint): string {
  if (value < 0n || value >= 2n ** 256n) throw new Error(`abi word out of range: ${value}`);
  return value.toString(16).padStart(64, '0');
}

/** ABI revert data for an error: 4-byte selector, then one word per static argument. */
export function encodeRevert(signature: string, args: readonly bigint[]): string {
  return selectorOf(signature) + args.map(word).join('');
}

export function gateRevertData(rejection: GateRejection): string {
  const types = GATE_ERRORS[rejection.error];
  if (types.length !== rejection.args.length) throw new Error(`argument count mismatch for ${rejection.error}`);
  return encodeRevert(errorSignature(rejection.error, types), rejection.args);
}
