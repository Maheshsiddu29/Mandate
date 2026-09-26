/**
 * Reference model of `MandateExecutionGate.execute`.
 *
 * This is the TypeScript side of the differential test (design §10.5, AGENTS.md
 * §4.5). It is deliberately *not* a port of the Solidity: wherever the kernel
 * already owns a rule, the model asks the kernel.
 *
 * - Mandate and candidate structure: the kernel's `decodeMandate` /
 *   `decodeCandidate` over the exact bytes the gate hashes. So "the gate accepts
 *   this struct" is compared against "the kernel's decoder accepts these bytes".
 * - Principal signature: the kernel's `verifyAuthorization`, with the gate's
 *   domain as the expected domain. So "the gate accepts this principal
 *   signature" is compared against the kernel's own acceptance rule.
 * - Canonical-asset equality: the kernel's `canonicalAssetIdEquals`.
 *
 * What the model adds is only what is new in Phase 6: the market table, the
 * execution commitment, chain time, onchain replay, and settlement on measured
 * balances.
 *
 * The gate reverts on the first failed check, so — unlike the kernel verifier,
 * which reports every violation — the model returns the first refusal in the
 * gate's order. That order is part of the interface; both implementations
 * reproduce it and the corpus compares the resulting revert data.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  AuthorizationScheme,
  PARTY_KIND_EIP155_ADDRESS,
  addAmounts,
  bytesToHex,
  canonicalAssetIdEquals,
  compareAmounts,
  decodeCandidate,
  decodeMandate,
  hexToBytes,
  keccak256,
  notionalBounds,
  subtractAmounts,
  verifyAuthorization,
  type Bytes32,
  type CanonicalMandate,
  type ExecutionCandidate,
  type Price,
} from '@mandate/kernel';
import { caip2, eip712Hash, executionCommitment, gateDomain, representationIdFor } from './commitment.ts';
import { reject, type GateRejection } from './errors.ts';
import { UINT256_MAX, ceilToScale, floorToScale } from './scale.ts';
import {
  encodeGateCandidate,
  encodeGateMandate,
  type Address,
  type GateAsset,
  type GateCandidate,
  type GateMandate,
  type GateTerms,
} from './wire.ts';

/** Kernel limits the gate re-imposes (`MandateCodec.sol`). */
const IDENTIFIER_MAX_LENGTH = 128;
const MAX_SET_SIZE = 1024;
export const MAX_PROFILE_SET_SIZE = 16;
export const MAX_EXECUTION_DATA_BYTES = 4_096;
export const MAX_MARKETS = 32;

/** Solidity `MarketConfig`, plus the decimals the constructor pins. */
export interface GateMarket {
  readonly representation: Address;
  readonly fundingToken: Address;
  readonly adapter: Address;
  readonly representationDecimals: number;
  readonly fundingDecimals: number;
  readonly canonicalAsset: GateAsset;
  readonly issuer: string;
  readonly venue: string;
  readonly quantityUnit: string;
  readonly settlementUnit: string;
  readonly synthetic: boolean;
  readonly classification: 'FIXTURE';
  /** Immutable engineered fixture price; real markets need attested state. */
  readonly fixturePrice: {
    readonly numeratorUnit: string;
    readonly denominatorUnit: string;
    readonly decimals: number;
    readonly atoms: bigint;
  };
}

/** One deployed gate: its chain, its address and its immutable markets. */
export interface GateDeployment {
  readonly chainId: bigint;
  readonly gate: Address;
  readonly markets: readonly GateMarket[];
}

/** One call to `execute`. */
export interface GateAttempt {
  readonly mandate: GateMandate;
  readonly principalSignature: string;
  readonly candidate: GateCandidate;
  readonly terms: GateTerms;
  readonly agentSignature: string;
}

/** What the chain supplies at execution. Never caller-supplied onchain. */
export interface ChainContext {
  readonly chainId: bigint;
  readonly timestamp: bigint;
  /** Mandate digests the gate has already recorded as consumed. */
  readonly consumed: ReadonlySet<string>;
  /** Current token decimals, when they differ from what the market pinned. */
  readonly tokenDecimals?: ReadonlyMap<Address, number>;
}

/** Everything the gate resolves before it changes state or calls out. */
export interface ExecutionPlan {
  readonly mandateDigest: Bytes32;
  readonly candidateDigest: Bytes32;
  readonly executionCommitment: Bytes32;
  readonly market: GateMarket;
  readonly side: 'BUY' | 'SELL';
  readonly principal: Address;
  readonly agent: Address;
  readonly recipient: Address;
  readonly inputToken: Address;
  readonly outputToken: Address;
  /** Exactly what the gate transfers from the principal to the adapter. */
  readonly inputAmount: bigint;
  /** The least output the recipient must receive. */
  readonly minOutput: bigint;
  /** Candidate quantity, enforced exactly on the representation leg. */
  readonly exactQuantity: bigint;
}

export type Decision<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly rejection: GateRejection };

const HALF_N = secp256k1.Point.Fn.ORDER / 2n;
const N = secp256k1.Point.Fn.ORDER;

/** Pre-signing executable-profile check for callers that build gate attempts. */
export function validateExecutionProfile(mandate: GateMandate, terms: GateTerms): Decision<true> {
  if (
    mandate.allowedIssuers.length > MAX_PROFILE_SET_SIZE ||
    mandate.allowedChains.length > MAX_PROFILE_SET_SIZE ||
    mandate.allowedVenues.length > MAX_PROFILE_SET_SIZE ||
    (terms.executionData.length - 2) / 2 > MAX_EXECUTION_DATA_BYTES
  ) return reject('ExecutionProfileExceeded');
  return { ok: true, value: true };
}

/**
 * Recover an EIP-712 signer under the kernel's acceptance rule: exactly 65
 * bytes, `v` in {27, 28}, `0 < r, s < n`, low `s`. `undefined` for anything else.
 */
export function recoverSigner(hash: Uint8Array, signature: string): Address | undefined {
  const sig = hexToBytes(signature);
  if (sig === undefined || sig.length !== 65) return undefined;
  const v = sig[64] as number;
  if (v !== 27 && v !== 28) return undefined;
  let r = 0n;
  let s = 0n;
  for (let i = 0; i < 32; i += 1) r = (r << 8n) | BigInt(sig[i] as number);
  for (let i = 32; i < 64; i += 1) s = (s << 8n) | BigInt(sig[i] as number);
  if (r === 0n || r >= N || s === 0n || s >= N || s > HALF_N) return undefined;
  try {
    const point = secp256k1.Signature.fromBytes(sig.subarray(0, 64)).addRecoveryBit(v - 27).recoverPublicKey(hash);
    return bytesToHex(keccak_256(point.toBytes(false).subarray(1)).subarray(12));
  } catch {
    return undefined;
  }
}

const utf8 = new TextEncoder();

function fits(s: string): boolean {
  return utf8.encode(s).length <= IDENTIFIER_MAX_LENGTH;
}

function assetFits(a: GateAsset): boolean {
  return fits(a.assetClass) && fits(a.idScheme) && fits(a.value);
}

function setFits(values: readonly string[]): boolean {
  return values.length <= MAX_SET_SIZE && values.every(fits);
}

/**
 * The mandate the gate would accept, or why not.
 *
 * Strings longer than an identifier can be, and sets larger than the kernel
 * permits, are refused before encoding — the gate refuses them as
 * non-identifiers, and the kernel writer could not length-prefix them.
 */
export function decodeGateMandate(m: GateMandate): Decision<{ mandate: CanonicalMandate; digest: Bytes32 }> {
  if (m.version !== 2n) return reject('UnsupportedMandateVersion');
  const sized =
    assetFits(m.canonicalAsset) &&
    fits(m.maxNotional.unit) &&
    fits(m.economicLimit.unit) &&
    setFits(m.allowedIssuers) &&
    setFits(m.allowedChains) &&
    setFits(m.allowedVenues);
  if (!sized) return reject('MalformedMandate');
  const bytes = encodeGateMandate(m);
  const decoded = decodeMandate(bytes);
  if (!decoded.ok) return reject(decoded.error === 'UNSUPPORTED_MANDATE_VERSION' ? 'UnsupportedMandateVersion' : 'MalformedMandate');
  return { ok: true, value: { mandate: decoded.value, digest: keccak256(bytes) } };
}

export function decodeGateCandidate(c: GateCandidate): Decision<{ candidate: ExecutionCandidate; digest: Bytes32 }> {
  const sized =
    fits(c.representationId) && assetFits(c.canonicalAsset) && fits(c.issuer) && fits(c.chain) && fits(c.venue) &&
    fits(c.quantity.unit) && fits(c.executionPrice.numeratorUnit) && fits(c.executionPrice.denominatorUnit) &&
    fits(c.notional.unit) && fits(c.feeTotal.unit) && fits(c.evaluationStateId);
  if (c.version !== 3n || !sized) return reject('MalformedCandidate');
  const bytes = encodeGateCandidate(c);
  const decoded = decodeCandidate(bytes);
  if (!decoded.ok) return reject('MalformedCandidate');
  return { ok: true, value: { candidate: decoded.value, digest: keccak256(bytes) } };
}

/**
 * Everything `execute` checks before it consumes the authorization and calls
 * out, in the gate's order.
 */
export function authorizeExecution(deployment: GateDeployment, attempt: GateAttempt, chain: ChainContext): Decision<ExecutionPlan> {
  if (chain.chainId !== deployment.chainId) return reject('WrongChain');
  const domain = gateDomain(deployment.chainId, deployment.gate);

  const md = decodeGateMandate(attempt.mandate);
  if (!md.ok) return md;
  const { mandate, digest: mandateDigest } = md.value;
  if (
    mandate.allowedIssuers.length > MAX_PROFILE_SET_SIZE ||
    mandate.allowedChains.length > MAX_PROFILE_SET_SIZE ||
    mandate.allowedVenues.length > MAX_PROFILE_SET_SIZE
  ) return reject('ExecutionProfileExceeded');

  const principalCheck = verifyAuthorization(
    {
      scheme: AuthorizationScheme.EIP712_SECP256K1,
      signer: mandate.principal,
      signature: attempt.principalSignature,
      domain,
    },
    mandateDigest,
    domain,
  );
  if (!principalCheck.ok) return reject('PrincipalSignatureInvalid');

  const cd = decodeGateCandidate(attempt.candidate);
  if (!cd.ok) return cd;
  const { candidate, digest: candidateDigest } = cd.value;
  if ((attempt.terms.executionData.length - 2) / 2 > MAX_EXECUTION_DATA_BYTES) {
    return reject('ExecutionProfileExceeded');
  }

  const market = deployment.markets.find(
    (m) => representationIdFor(deployment.chainId, m.representation) === candidate.representationId,
  );
  if (market === undefined) return reject('UnsupportedRepresentation');

  const commitment = executionCommitment({ mandateDigest, candidateDigest, terms: attempt.terms });
  if (recoverSigner(eip712Hash(domain, commitment), attempt.agentSignature) !== mandate.agent.value) {
    return reject('AgentSignatureInvalid');
  }

  const now = chain.timestamp;
  if (now < mandate.notBeforeUnixSeconds) return reject('MandateNotYetActive');
  if (now >= mandate.expiresAtUnixSeconds) return reject('MandateExpired');
  if (now > attempt.terms.deadline) return reject('ExecutionDeadlinePassed');

  if (chain.consumed.has(mandateDigest)) return reject('MandateAlreadyConsumed');

  const binding = checkBinding(deployment, mandate, candidate, market);
  if (binding !== undefined) return { ok: false, rejection: binding };

  const economics = checkEconomics(mandate, candidate, market);
  if (economics !== undefined) return { ok: false, rejection: economics };

  return plan(mandate, candidate, market, attempt.terms, chain, { mandateDigest, candidateDigest, commitment });
}

function checkBinding(
  deployment: GateDeployment,
  mandate: CanonicalMandate,
  candidate: ExecutionCandidate,
  market: GateMarket,
): GateRejection | undefined {
  const fail = (error: GateRejection['error']): GateRejection => ({ error, args: [] });
  if (candidate.agent.kind !== PARTY_KIND_EIP155_ADDRESS || candidate.agent.value !== mandate.agent.value) return fail('AgentMismatch');
  if (candidate.side !== mandate.side) return fail('SideMismatch');
  if (!canonicalAssetIdEquals(candidate.canonicalAsset, mandate.canonicalAsset)) return fail('CanonicalAssetMismatch');
  const marketAsset = market.canonicalAsset;
  const marketMatches =
    marketAsset.assetClass === mandate.canonicalAsset.assetClass &&
    marketAsset.idScheme === mandate.canonicalAsset.idScheme &&
    marketAsset.value === mandate.canonicalAsset.value;
  if (!marketMatches) return fail('RepresentationAssetMismatch');
  const chainId = caip2(deployment.chainId);
  if (candidate.chain !== chainId) return fail('ChainMismatch');
  if (!mandate.allowedChains.includes(chainId as (typeof mandate.allowedChains)[number])) return fail('ChainNotAllowed');
  if (candidate.venue !== market.venue) return fail('VenueMismatch');
  if (!(mandate.allowedVenues as readonly string[]).includes(market.venue)) return fail('VenueNotAllowed');
  if (candidate.issuer !== market.issuer) return fail('IssuerMismatch');
  if (!(mandate.allowedIssuers as readonly string[]).includes(market.issuer)) return fail('IssuerNotAllowed');
  if (market.synthetic && mandate.syntheticPolicy === 'FORBIDDEN') return fail('SyntheticNotAllowed');
  if (candidate.quantity.unit !== market.quantityUnit || candidate.quantity.decimals !== market.representationDecimals) {
    return fail('QuantityUnitMismatch');
  }
  if (candidate.quantity.atoms === 0n) return fail('ZeroQuantity');
  if (mandate.economicLimit.unit !== market.settlementUnit) return fail('SettlementUnitMismatch');
  return undefined;
}

function checkEconomics(
  mandate: CanonicalMandate,
  candidate: ExecutionCandidate,
  market: GateMarket,
): GateRejection | undefined {
  const fail = (error: GateRejection['error'], ...args: bigint[]): GateRejection => ({ error, args });
  if (
    candidate.notional.unit !== market.settlementUnit ||
    candidate.feeTotal.unit !== market.settlementUnit ||
    candidate.executionPrice.numeratorUnit !== market.settlementUnit ||
    candidate.executionPrice.denominatorUnit !== market.quantityUnit
  ) return fail('EconomicUnitMismatch');
  const priceScale = Math.max(candidate.executionPrice.decimals, market.fixturePrice.decimals);
  const candidatePrice = candidate.executionPrice.atoms * 10n ** BigInt(priceScale - candidate.executionPrice.decimals);
  const pinnedPrice = market.fixturePrice.atoms * 10n ** BigInt(priceScale - market.fixturePrice.decimals);
  if (candidatePrice !== pinnedPrice) return fail('FixturePriceMismatch');

  const bounds = notionalBounds(
    candidate.quantity,
    candidate.executionPrice,
    candidate.notional.unit,
    candidate.notional.decimals,
  );
  if (!bounds.ok) return fail('NotionalOutOfRange');
  if (candidate.notional.atoms < bounds.value.floorAtoms || candidate.notional.atoms > bounds.value.ceilAtoms) {
    return fail(
      'NotionalInconsistent',
      candidate.notional.atoms,
      bounds.value.floorAtoms,
      bounds.value.ceilAtoms,
    );
  }

  const max = compareAmounts(candidate.notional, mandate.maxNotional);
  if (!max.ok) return fail('EconomicUnitMismatch');
  if (max.value > 0) return fail('MaxNotionalExceeded');
  // The kernel's own rule (checkMaxNotional): the true quantity x price at the
  // principal's precision, rounded up, never the agent's chosen rendering. The
  // gate's price is the pinned fixture price, which the check above proved equal.
  const product = notionalBounds(candidate.quantity, market.fixturePrice as Price, mandate.maxNotional.unit, mandate.maxNotional.decimals);
  if (!product.ok && product.error !== 'VALUE_OUT_OF_RANGE') return fail('EconomicUnitMismatch');
  if (!product.ok || product.value.ceilAtoms > mandate.maxNotional.atoms) return fail('MaxNotionalExceeded');

  if (mandate.side === 'BUY') {
    const debit = addAmounts(candidate.notional, candidate.feeTotal);
    if (!debit.ok) {
      return fail(debit.error === 'VALUE_OUT_OF_RANGE' ? 'DeclaredEconomicValueOutOfRange' : 'EconomicUnitMismatch');
    }
    const within = compareAmounts(debit.value, mandate.economicLimit);
    if (!within.ok) return fail('EconomicUnitMismatch');
    if (within.value > 0) return fail('DeclaredTotalDebitExceeded');
  } else {
    const fees = compareAmounts(candidate.feeTotal, candidate.notional);
    if (!fees.ok) return fail('EconomicUnitMismatch');
    if (fees.value >= 0) return fail('DeclaredFeesExceedNotional');
    const credit = subtractAmounts(candidate.notional, candidate.feeTotal);
    if (!credit.ok) {
      return fail(credit.error === 'VALUE_OUT_OF_RANGE' ? 'DeclaredEconomicValueOutOfRange' : 'EconomicUnitMismatch');
    }
    const within = compareAmounts(credit.value, mandate.economicLimit);
    if (!within.ok) return fail('EconomicUnitMismatch');
    if (within.value < 0) return fail('DeclaredTotalCreditBelowMinimum');
  }
  return undefined;
}

function plan(
  mandate: CanonicalMandate,
  candidate: ExecutionCandidate,
  market: GateMarket,
  terms: GateTerms,
  chain: ChainContext,
  digests: { mandateDigest: Bytes32; candidateDigest: Bytes32; commitment: Bytes32 },
): Decision<ExecutionPlan> {
  if (terms.recipient !== mandate.principal.value) return reject('RecipientNotPrincipal');

  const quantity = candidate.quantity.atoms;
  const limit = mandate.economicLimit;
  let inputToken: Address;
  let outputToken: Address;
  let inputAmount: bigint;
  let minOutput: bigint;
  if (mandate.side === 'BUY') {
    const bound = floorToScale(limit.atoms, limit.decimals, market.fundingDecimals);
    if (terms.fundingLimit > bound) return reject('FundingLimitExceedsMandate', terms.fundingLimit, bound);
    inputToken = market.fundingToken;
    outputToken = market.representation;
    inputAmount = terms.fundingLimit;
    minOutput = quantity;
  } else {
    const bound = ceilToScale(limit.atoms, limit.decimals, market.fundingDecimals);
    if (bound === undefined) return reject('FundingLimitBelowMandate', terms.fundingLimit, UINT256_MAX);
    if (terms.fundingLimit < bound) return reject('FundingLimitBelowMandate', terms.fundingLimit, bound);
    inputToken = market.representation;
    outputToken = market.fundingToken;
    inputAmount = quantity;
    minOutput = terms.fundingLimit;
  }

  const decimalsNow = (token: Address, pinned: number): number => chain.tokenDecimals?.get(token) ?? pinned;
  if (decimalsNow(market.representation, market.representationDecimals) !== market.representationDecimals) {
    return reject('TokenDecimalsChanged', BigInt(market.representation));
  }
  if (decimalsNow(market.fundingToken, market.fundingDecimals) !== market.fundingDecimals) {
    return reject('TokenDecimalsChanged', BigInt(market.fundingToken));
  }

  return {
    ok: true,
    value: {
      mandateDigest: digests.mandateDigest,
      candidateDigest: digests.candidateDigest,
      executionCommitment: digests.commitment,
      market,
      side: mandate.side,
      principal: mandate.principal.value,
      agent: mandate.agent.value,
      recipient: terms.recipient,
      inputToken,
      outputToken,
      inputAmount,
      minOutput,
      exactQuantity: quantity,
    },
  };
}

/** Balances the gate reads around the adapter call. */
export interface MeasuredBalances {
  /** Principal's input-token balance before the transfer to the adapter. */
  readonly inputBefore: bigint;
  readonly inputAfter: bigint;
  /** Recipient's output-token balance before the transfer to the adapter. */
  readonly outputBefore: bigint;
  readonly outputAfter: bigint;
}

export interface Settlement {
  readonly actualDebit: bigint;
  readonly actualCredit: bigint;
}

/**
 * The gate's settlement decision on measured balances.
 *
 * BUY: debit <= fundingLimit (<= the signed MAX_TOTAL_DEBIT) and credit >= quantity.
 * SELL: debit <= quantity and credit >= fundingLimit (>= the signed MIN_TOTAL_CREDIT).
 * Nothing an adapter reports is consulted.
 */
export function settleExecution(plan: ExecutionPlan, measured: MeasuredBalances): Decision<Settlement> {
  const actualDebit = measured.inputBefore > measured.inputAfter ? measured.inputBefore - measured.inputAfter : 0n;
  const actualCredit = measured.outputAfter > measured.outputBefore ? measured.outputAfter - measured.outputBefore : 0n;
  if (plan.side === 'BUY') {
    if (actualDebit > plan.inputAmount) return reject('DebitExceedsLimit', actualDebit, plan.inputAmount);
    if (actualCredit !== plan.exactQuantity) return reject('CreditNotExact', actualCredit, plan.exactQuantity);
  } else {
    if (actualDebit !== plan.exactQuantity) return reject('DebitNotExact', actualDebit, plan.exactQuantity);
    if (actualCredit < plan.minOutput) return reject('CreditBelowMinimum', actualCredit, plan.minOutput);
  }
  return { ok: true, value: { actualDebit, actualCredit } };
}
