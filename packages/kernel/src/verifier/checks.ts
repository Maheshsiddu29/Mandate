/**
 * The check families (design section 10.2).
 *
 * Each check is an independent pure function from the verification context to a
 * list of violations. Independence is the point: the verifier runs all of them
 * and unions the results, so a rejection names every violated constraint rather
 * than stopping at the first (design section 10.1, property 6), and the verdict
 * cannot depend on the order they ran in (property 7).
 *
 * A check reports what it can establish and nothing more. Where a check needs
 * state that is absent or unknown, it produces a violation — never a silent
 * pass and never a default.
 */

import { canonicalAssetIdEquals } from '../identifiers.ts';
import type { ReasonCodeName } from '../reason-codes.ts';
import { addAmounts, compareAmounts, deviationBps, notionalBounds, subtractAmounts } from '../units.ts';
import { EconomicLimitKind, HaltPolicy, Side, SyntheticPolicy, economicLimitKind, partyIdEquals, type CanonicalMandate } from '../mandate.ts';
import type { ExecutionCandidate } from '../candidate.ts';
import { HaltStatus, OperationalState, ReplayStatus, TriState, findRepresentation, type TrustedState } from '../state.ts';
import { isTrustedForAuthorization, type Observed } from '../trust.ts';
import type { Clock } from '../time.ts';
import type { Bytes32 } from '../bytes.ts';
import { chainSegmentOf } from '../identifiers.ts';
import type { AuthorizationEnvelope } from '../authorization/envelope.ts';
import { verifyAuthorization } from '../authorization/envelope.ts';
import type { Eip712Domain } from '../authorization/eip712.ts';

export interface Violation {
  readonly code: ReasonCodeName;
  /** Machine-readable specifics. String values only, so a receipt encodes canonically. */
  readonly detail: Readonly<Record<string, string>>;
}

export function violation(code: ReasonCodeName, detail: Readonly<Record<string, string>> = {}): Violation {
  return { code, detail };
}

export interface CheckContext {
  readonly mandate: CanonicalMandate;
  readonly authorization: AuthorizationEnvelope;
  readonly candidate: ExecutionCandidate;
  readonly state: TrustedState;
  readonly clock: Clock;
  readonly expectedDomain: Eip712Domain;
  readonly mandateDigest: Bytes32;
  /** Computed by `verify` over the state it was handed. The candidate must commit to it. */
  readonly trustedStateDigest: Bytes32;
}

export interface Check {
  readonly name: string;
  readonly run: (ctx: CheckContext) => readonly Violation[];
}

const none: readonly Violation[] = [];

// --- A. Mandate integrity / B. Authorization scope --------------------------

const checkSignature: Check = {
  name: 'signature',
  run: (ctx) => {
    const result = verifyAuthorization(ctx.authorization, ctx.mandateDigest, ctx.expectedDomain);
    if (!result.ok) return [violation(result.error, { scheme: ctx.authorization.scheme })];
    // A valid signature proves who signed. Whether that signer is the principal
    // is a separate question, and this is where it is asked.
    if (!partyIdEquals(result.value, ctx.mandate.principal)) {
      return [violation('SIGNER_UNAUTHORIZED', { expected: ctx.mandate.principal.value, observed: result.value.value })];
    }
    return none;
  },
};

const checkAgent: Check = {
  name: 'agent',
  run: (ctx) =>
    partyIdEquals(ctx.candidate.agent, ctx.mandate.agent)
      ? none
      : [violation('AGENT_UNAUTHORIZED', { expected: ctx.mandate.agent.value, observed: ctx.candidate.agent.value })],
};

const checkValidityWindow: Check = {
  name: 'validity-window',
  run: (ctx) => {
    const now = ctx.clock.nowUnixSeconds;
    const out: Violation[] = [];
    // Expiry is exclusive of the instant itself: at t == expiresAt the mandate
    // is expired. An authorization that is live exactly at its stated end is a
    // boundary nobody agrees on, so the strict reading is chosen and tested.
    if (now >= ctx.mandate.expiresAtUnixSeconds) {
      out.push(violation('MANDATE_EXPIRED', { now: String(now), expiresAt: String(ctx.mandate.expiresAtUnixSeconds) }));
    }
    if (now < ctx.mandate.notBeforeUnixSeconds) {
      out.push(violation('MANDATE_NOT_YET_ACTIVE', { now: String(now), notBefore: String(ctx.mandate.notBeforeUnixSeconds) }));
    }
    return out;
  },
};

const checkReplay: Check = {
  name: 'replay',
  run: (ctx) => {
    const replay = ctx.state.replay;
    if (replay === null) return [violation('TRUSTED_STATE_MISSING', { input: 'replay' })];
    // A replay record about some other mandate establishes nothing about this
    // one, so it is unknown rather than unused.
    if (replay.value.mandateDigest !== ctx.mandateDigest) {
      return [violation('REPLAY_STATE_UNKNOWN', { reason: 'record-is-for-a-different-mandate' })];
    }
    switch (replay.value.status) {
      case ReplayStatus.CONSUMED:
        return [violation('MANDATE_ALREADY_CONSUMED', { mandateDigest: ctx.mandateDigest })];
      case ReplayStatus.RESERVED:
        // A concurrent attempt holds this authorization. Letting a second
        // attempt through would be the double-spend the reservation prevents.
        return [violation('MANDATE_RESERVED', { mandateDigest: ctx.mandateDigest })];
      case ReplayStatus.QUARANTINED:
        // An earlier attempt may already have executed this trade. Only
        // reconciliation can say, and until it does the authorization is not
        // available at any price.
        return [violation('MANDATE_QUARANTINED', { mandateDigest: ctx.mandateDigest })];
      case ReplayStatus.UNKNOWN:
        return [violation('REPLAY_STATE_UNKNOWN', { reason: 'source-reported-unknown' })];
      case ReplayStatus.UNUSED:
        return none;
    }
  },
};

// --- C. Asset identity / NET ------------------------------------------------

const checkCanonicalAsset: Check = {
  name: 'canonical-asset',
  run: (ctx) =>
    canonicalAssetIdEquals(ctx.candidate.canonicalAsset, ctx.mandate.canonicalAsset)
      ? none
      : [
          violation('CANONICAL_ASSET_MISMATCH', {
            expected: ctx.mandate.canonicalAsset.value,
            observed: ctx.candidate.canonicalAsset.value,
          }),
        ],
};

const checkChain: Check = {
  name: 'chain',
  run: (ctx) =>
    ctx.mandate.allowedChains.includes(ctx.candidate.chain)
      ? none
      : [violation('CHAIN_NOT_ALLOWED', { observed: ctx.candidate.chain })],
};

const checkVenue: Check = {
  name: 'venue',
  run: (ctx) =>
    ctx.mandate.allowedVenues.includes(ctx.candidate.venue)
      ? none
      : [violation('VENUE_NOT_ALLOWED', { observed: ctx.candidate.venue })],
};

const checkSide: Check = {
  name: 'side',
  run: (ctx) =>
    ctx.candidate.side === ctx.mandate.side
      ? none
      : [violation('SIDE_MISMATCH', { expected: ctx.mandate.side, observed: ctx.candidate.side })],
};

// --- D. Representation semantics --------------------------------------------

const checkRepresentation: Check = {
  name: 'representation',
  run: (ctx) => {
    const observed = findRepresentation(ctx.state, ctx.candidate.representationId);
    // An unregistered representation is never admissible. This is the check that
    // makes a hallucinated or injected contract address unusable: the candidate
    // may name anything, but only a registry entry resolves.
    if (observed === undefined) {
      return [violation('REPRESENTATION_UNKNOWN', { representationId: ctx.candidate.representationId })];
    }
    const rep = observed.value;
    const out: Violation[] = [];

    if (!canonicalAssetIdEquals(rep.canonicalAsset, ctx.mandate.canonicalAsset)) {
      out.push(
        violation('REPRESENTATION_ASSET_MISMATCH', {
          expected: ctx.mandate.canonicalAsset.value,
          observed: rep.canonicalAsset.value,
        }),
      );
    }
    // The candidate claims an issuer and a chain; the registry establishes them.
    // A disagreement means the candidate is describing something other than the
    // representation it named.
    if (rep.issuer !== ctx.candidate.issuer) {
      out.push(violation('REPRESENTATION_ATTRIBUTES_MISMATCH', { field: 'issuer', expected: rep.issuer, observed: ctx.candidate.issuer }));
    }
    if (rep.chain !== ctx.candidate.chain) {
      out.push(violation('REPRESENTATION_ATTRIBUTES_MISMATCH', { field: 'chain', expected: rep.chain, observed: ctx.candidate.chain }));
    }
    if (!ctx.mandate.allowedIssuers.includes(rep.issuer)) {
      out.push(violation('ISSUER_NOT_ALLOWED', { observed: rep.issuer }));
    }

    if (rep.synthetic === TriState.UNKNOWN) {
      out.push(violation('REPRESENTATION_METADATA_UNKNOWN', { field: 'synthetic' }));
    } else if (rep.synthetic === TriState.YES && ctx.mandate.syntheticPolicy === SyntheticPolicy.FORBIDDEN) {
      out.push(violation('SYNTHETIC_NOT_ALLOWED', { representationId: rep.representationId }));
    }

    if (rep.operationalState === OperationalState.UNKNOWN) {
      out.push(violation('REPRESENTATION_METADATA_UNKNOWN', { field: 'operationalState' }));
    } else if (rep.operationalState !== OperationalState.ACTIVE) {
      out.push(violation('REPRESENTATION_INACTIVE', { observed: rep.operationalState }));
    }

    return out;
  },
};

/**
 * Reconcile the chain a representation identifier carries with the chain field
 * carried beside it.
 *
 * A representation identifier is CAIP-19 shaped, so it already names the chain
 * the contract lives on. Carrying the chain a second time as a field creates two
 * sources for one security-critical value, and the pressure test found that only
 * the second was ever checked against the mandate's allowlist — so a contract on
 * one chain could be presented under a mandate that permits only another.
 *
 * The identifier is the canonical source, because it is what an execution will
 * address. This check does not parse a contract address out of anything: it
 * reads the segment before the first `/` and compares it, which is the minimum
 * needed to close the redundancy.
 */
const checkRepresentationChain: Check = {
  name: 'representation-chain',
  run: (ctx) => {
    const out: Violation[] = [];
    const candidateChain = chainSegmentOf(ctx.candidate.representationId);
    if (candidateChain === undefined || candidateChain !== ctx.candidate.chain) {
      out.push(
        violation('REPRESENTATION_CHAIN_INCONSISTENT', {
          source: 'candidate',
          representationId: ctx.candidate.representationId,
          declared: ctx.candidate.chain,
        }),
      );
    }
    for (const observed of ctx.state.representations) {
      const rep = observed.value;
      const stateChain = chainSegmentOf(rep.representationId);
      if (stateChain === undefined || stateChain !== rep.chain) {
        out.push(
          violation('REPRESENTATION_CHAIN_INCONSISTENT', {
            source: 'trustedState',
            representationId: rep.representationId,
            declared: rep.chain,
          }),
        );
      }
    }
    return out;
  },
};

// --- E. Economic bounds -----------------------------------------------------

const checkNotionalConsistency: Check = {
  name: 'notional-consistency',
  run: (ctx) => {
    const c = ctx.candidate;
    const bounds = notionalBounds(c.quantity, c.executionPrice, c.notional.unit, c.notional.decimals);
    if (!bounds.ok) return [violation(bounds.error, { check: 'notional-consistency' })];
    // Either rounding convention is accepted; anything outside the one-atom band
    // is a decimal transposition or an amount error, which is the failure this
    // check exists to catch.
    if (c.notional.atoms < bounds.value.floorAtoms || c.notional.atoms > bounds.value.ceilAtoms) {
      return [
        violation('NOTIONAL_INCONSISTENT', {
          declared: String(c.notional.atoms),
          floor: String(bounds.value.floorAtoms),
          ceil: String(bounds.value.ceilAtoms),
        }),
      ];
    }
    return none;
  },
};

const checkMaxNotional: Check = {
  name: 'max-notional',
  run: (ctx) => {
    const cmp = compareAmounts(ctx.candidate.notional, ctx.mandate.maxNotional);
    if (!cmp.ok) return [violation(cmp.error, { check: 'max-notional' })];
    return cmp.value > 0
      ? [
          violation('MAX_NOTIONAL_EXCEEDED', {
            declared: String(ctx.candidate.notional.atoms),
            maximum: String(ctx.mandate.maxNotional.atoms),
          }),
        ]
      : none;
  },
};

/**
 * The signed cash-flow bound, read according to the mandate's side (ADR 0014).
 *
 * This is the check that makes economic authority symmetric and authoritative.
 * `maxNotional` bounds gross exposure and says nothing about fees; this one
 * bounds what the principal is actually debited or credited, and it lives here
 * rather than in the router because the router does not authorize anything.
 *
 * Arithmetic is exact and the rounding direction is not a question: both sides
 * are integer atoms lifted to a common scale by a power of ten, so `addAmounts`
 * and `subtractAmounts` are exact and the only failure modes are a unit
 * mismatch and an overflow, both of which reject.
 */
const checkEconomicLimit: Check = {
  name: 'economic-limit',
  run: (ctx) => {
    const c = ctx.candidate;
    const limit = ctx.mandate.economicLimit;

    if (economicLimitKind(ctx.mandate.side) === EconomicLimitKind.MAX_TOTAL_DEBIT) {
      const debit = addAmounts(c.notional, c.feeTotal);
      if (!debit.ok) return [violation(debit.error, { check: 'economic-limit', kind: EconomicLimitKind.MAX_TOTAL_DEBIT })];
      const cmp = compareAmounts(debit.value, limit);
      if (!cmp.ok) return [violation(cmp.error, { check: 'economic-limit' })];
      return cmp.value > 0
        ? [violation('TOTAL_DEBIT_EXCEEDED', { declared: String(debit.value.atoms), decimals: String(debit.value.decimals), maximum: String(limit.atoms), maximumDecimals: String(limit.decimals) })]
        : none;
    }

    // SELL. Fees at or above the notional make this a net debit, and there is no
    // defensible minimum credit to compare a debit against, so it fails closed
    // before the comparison rather than producing a nonsensical one.
    const feesVsNotional = compareAmounts(c.feeTotal, c.notional);
    if (!feesVsNotional.ok) return [violation(feesVsNotional.error, { check: 'economic-limit' })];
    if (feesVsNotional.value >= 0) {
      return [violation('FEES_EXCEED_NOTIONAL', { fees: String(c.feeTotal.atoms), notional: String(c.notional.atoms) })];
    }
    const credit = subtractAmounts(c.notional, c.feeTotal);
    if (!credit.ok) return [violation(credit.error, { check: 'economic-limit', kind: EconomicLimitKind.MIN_TOTAL_CREDIT })];
    const cmp = compareAmounts(credit.value, limit);
    if (!cmp.ok) return [violation(cmp.error, { check: 'economic-limit' })];
    return cmp.value < 0
      ? [violation('TOTAL_CREDIT_BELOW_MINIMUM', { declared: String(credit.value.atoms), decimals: String(credit.value.decimals), minimum: String(limit.atoms), minimumDecimals: String(limit.decimals) })]
      : none;
  },
};

const checkPriceDeviation: Check = {
  name: 'price-deviation',
  run: (ctx) => {
    const market = ctx.state.market;
    if (market === null) return [violation('TRUSTED_STATE_MISSING', { input: 'market' })];
    if (!canonicalAssetIdEquals(market.value.canonicalAsset, ctx.mandate.canonicalAsset)) {
      return [violation('MARKET_STATE_UNKNOWN', { reason: 'market-state-is-for-a-different-asset' })];
    }
    const reference = market.value.referencePrice;
    if (reference === null) return [violation('MARKET_STATE_UNKNOWN', { field: 'referencePrice' })];

    const bps = deviationBps(ctx.candidate.executionPrice, reference);
    if (!bps.ok) return [violation(bps.error, { check: 'price-deviation' })];
    return bps.value > ctx.mandate.maxDeviationBps
      ? [violation('PRICE_DEVIATION_EXCEEDED', { observedBps: String(bps.value), maximumBps: String(ctx.mandate.maxDeviationBps) })]
      : none;
  },
};

// --- F. Market and corporate-action state -----------------------------------

const checkPriceFreshness: Check = {
  name: 'price-freshness',
  run: (ctx) => {
    const market = ctx.state.market;
    if (market === null) return [violation('TRUSTED_STATE_MISSING', { input: 'market' })];
    const age = ctx.clock.nowUnixSeconds - market.provenance.observedAtUnixSeconds;
    // An observation timestamped after the evaluation instant means a broken
    // clock or a broken source. Freshness cannot be established, so it fails
    // closed rather than being treated as maximally fresh.
    if (age < 0n) return [violation('MARKET_STATE_UNKNOWN', { reason: 'observation-is-in-the-future', ageSeconds: String(age) })];
    return age > ctx.mandate.maxPriceAgeSeconds
      ? [violation('PRICE_STATE_STALE', { ageSeconds: String(age), maximumSeconds: String(ctx.mandate.maxPriceAgeSeconds) })]
      : none;
  },
};

const checkHalt: Check = {
  name: 'halt',
  run: (ctx) => {
    const market = ctx.state.market;
    if (market === null) return [violation('TRUSTED_STATE_MISSING', { input: 'market' })];
    if (market.value.haltStatus === HaltStatus.UNKNOWN) {
      return [violation('MARKET_STATE_UNKNOWN', { field: 'haltStatus' })];
    }
    return market.value.haltStatus === HaltStatus.HALTED && ctx.mandate.haltPolicy === HaltPolicy.FORBID_WHEN_HALTED
      ? [violation('TRADING_HALTED', {})]
      : none;
  },
};

const checkCorporateAction: Check = {
  name: 'corporate-action',
  run: (ctx) => {
    const ca = ctx.state.corporateAction;
    if (ca === null) return [violation('TRUSTED_STATE_MISSING', { input: 'corporateAction' })];
    if (!canonicalAssetIdEquals(ca.value.canonicalAsset, ctx.mandate.canonicalAsset)) {
      return [violation('CORPORATE_ACTION_STATE_UNKNOWN', { reason: 'state-is-for-a-different-asset' })];
    }

    const out: Violation[] = [];
    const age = ctx.clock.nowUnixSeconds - ca.provenance.observedAtUnixSeconds;
    if (age < 0n) {
      out.push(violation('CORPORATE_ACTION_STATE_UNKNOWN', { reason: 'observation-is-in-the-future' }));
    } else if (age > ctx.mandate.maxCorporateActionAgeSeconds) {
      // An epoch feed is itself state that can go stale. A current-looking epoch
      // observed an hour ago does not establish the epoch now.
      out.push(violation('CORPORATE_ACTION_STATE_STALE', { ageSeconds: String(age), maximumSeconds: String(ctx.mandate.maxCorporateActionAgeSeconds) }));
    }

    const observed = ca.value.epoch;
    if (observed === null) {
      out.push(violation('CORPORATE_ACTION_STATE_UNKNOWN', { field: 'epoch' }));
      return out;
    }

    const required = ctx.mandate.requiredCorporateActionEpoch;
    if (observed > required) {
      // Recovery is reauthorization. Rescaling the mandate across a split would
      // substitute this system's judgment for the principal's.
      out.push(violation('CORPORATE_ACTION_STATE_CHANGED', { authorized: String(required), observed: String(observed) }));
    } else if (observed < required) {
      out.push(violation('CORPORATE_ACTION_STATE_INCONSISTENT', { authorized: String(required), observed: String(observed) }));
    }

    if (ctx.candidate.corporateActionEpoch !== observed) {
      out.push(
        violation('CANDIDATE_STATE_MISMATCH', {
          field: 'corporateActionEpoch',
          observed: String(observed),
          candidate: String(ctx.candidate.corporateActionEpoch),
        }),
      );
    }
    return out;
  },
};

// --- G. Intent fidelity -----------------------------------------------------

/**
 * Bind the candidate to the *content* of the state it was built against.
 *
 * The label is checked too, because a mismatched label gives a clearer
 * diagnostic, but the digest is the binding. Two materially different states can
 * share one `stateId` — the caller chooses it freely — so matching the name
 * established nothing before schema v2 added `referenceStateDigest`.
 */
const checkStateBinding: Check = {
  name: 'state-binding',
  run: (ctx) => {
    const out: Violation[] = [];
    if (ctx.candidate.referenceStateId !== ctx.state.stateId) {
      out.push(
        violation('CANDIDATE_STATE_MISMATCH', {
          field: 'referenceStateId',
          observed: ctx.state.stateId,
          candidate: ctx.candidate.referenceStateId,
        }),
      );
    }
    if (ctx.candidate.referenceStateDigest !== ctx.trustedStateDigest) {
      out.push(
        violation('CANDIDATE_STATE_MISMATCH', {
          field: 'referenceStateDigest',
          observed: ctx.trustedStateDigest,
          candidate: ctx.candidate.referenceStateDigest,
        }),
      );
    }
    return out;
  },
};

/**
 * Re-assert trust levels at run time.
 *
 * The parser already refuses advisory and untrusted provenance for a trusted
 * slot, and TypeScript's brands document the intent. Neither survives to run
 * time on a hand-built object reaching an internal entry point, so the rule the
 * whole design rests on is checked here as well (ADR 0003).
 */
const checkTrustLevels: Check = {
  name: 'trust-levels',
  run: (ctx) => {
    const out: Violation[] = [];
    const inputs: readonly (readonly [string, Observed<unknown> | null])[] = [
      ['market', ctx.state.market],
      ['corporateAction', ctx.state.corporateAction],
      ['replay', ctx.state.replay],
      ...ctx.state.representations.map((o) => [`representation:${o.value.representationId}`, o] as const),
    ];
    for (const [name, input] of inputs) {
      if (input === null) continue;
      if (!isTrustedForAuthorization(input.provenance.trustClass)) {
        out.push(violation('UNTRUSTED_REQUIRED_STATE', { input: name, trustClass: input.provenance.trustClass }));
      }
    }
    return out;
  },
};

/**
 * Every check, in declaration order.
 *
 * Exported so the order-independence test can shuffle it, and so the set of
 * checks is legible as a list rather than buried in a function body.
 */
export const CHECKS: readonly Check[] = [
  checkSignature,
  checkAgent,
  checkValidityWindow,
  checkReplay,
  checkCanonicalAsset,
  checkChain,
  checkVenue,
  checkSide,
  checkRepresentation,
  checkRepresentationChain,
  checkNotionalConsistency,
  checkMaxNotional,
  checkEconomicLimit,
  checkPriceDeviation,
  checkPriceFreshness,
  checkHalt,
  checkCorporateAction,
  checkStateBinding,
  checkTrustLevels,
];
