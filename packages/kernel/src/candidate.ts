/**
 * The execution candidate: exactly what an agent or router proposes to execute
 * (design section 12.2).
 *
 * A candidate is proposed executable state. It carries no model reasoning, no
 * natural-language explanation and no Jev output, because the verifier must be
 * unable to tell whether a model was involved (design section 11.2). Anything a
 * model wrote about *why* this candidate was chosen belongs in the audit record
 * and never reaches a check.
 *
 * A candidate *claims* things — an issuer, a chain, a canonical asset. It does
 * not get to establish them. Every claim is cross-checked against trusted state
 * and a disagreement rejects.
 */

import { type Result, ok, err } from './result.ts';
import type { ReasonCodeName } from './reason-codes.ts';
import {
  parseIdentifier,
  parseCanonicalAssetId,
  type CanonicalAssetId,
  type ChainId,
  type IssuerId,
  type RepresentationId,
  type VenueId,
} from './identifiers.ts';
import { parseAmount, parsePrice, type Amount, type Price } from './units.ts';
import { parseBigInt } from './time.ts';
import { parsePartyId, Side, UINT64_MAX, type PartyId } from './mandate.ts';

export const CANDIDATE_SCHEMA_VERSION = 1;

export interface ExecutionCandidate {
  readonly version: number;

  /** Which tokenized representation. Opaque here; resolved through trusted state. */
  readonly representationId: RepresentationId;
  /** The canonical asset the candidate claims to deliver exposure to. */
  readonly canonicalAsset: CanonicalAssetId;
  readonly issuer: IssuerId;
  readonly chain: ChainId;
  readonly venue: VenueId;
  readonly side: Side;

  /** The agent proposing this. Checked against the mandate's authorized agent. */
  readonly agent: PartyId;

  readonly quantity: Amount;
  readonly executionPrice: Price;
  readonly notional: Amount;

  /** Which trusted-state snapshot this candidate was constructed against. */
  readonly referenceStateId: string;
  /** The corporate-action epoch the candidate was built under. */
  readonly corporateActionEpoch: bigint;
}

const CANDIDATE_FIELDS = [
  'version',
  'representationId',
  'canonicalAsset',
  'issuer',
  'chain',
  'venue',
  'side',
  'agent',
  'quantity',
  'executionPrice',
  'notional',
  'referenceStateId',
  'corporateActionEpoch',
] as const;

export function parseCandidate(raw: unknown): Result<ExecutionCandidate, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_CANDIDATE');
  const r = raw as Record<string, unknown>;

  const version = r['version'];
  if (typeof version !== 'number' || version !== CANDIDATE_SCHEMA_VERSION) return err('MALFORMED_CANDIDATE');

  const known = new Set<string>(CANDIDATE_FIELDS);
  for (const key of Object.keys(r)) if (!known.has(key)) return err('MALFORMED_CANDIDATE');

  const representationId = parseIdentifier(r['representationId']);
  if (!representationId.ok) return representationId;
  const canonicalAsset = parseCanonicalAssetId(r['canonicalAsset']);
  if (!canonicalAsset.ok) return canonicalAsset;
  const issuer = parseIdentifier(r['issuer']);
  if (!issuer.ok) return issuer;
  const chain = parseIdentifier(r['chain']);
  if (!chain.ok) return chain;
  const venue = parseIdentifier(r['venue']);
  if (!venue.ok) return venue;
  const side = r['side'];
  if (typeof side !== 'string' || !Object.prototype.hasOwnProperty.call(Side, side)) return err('MALFORMED_CANDIDATE');
  const agent = parsePartyId(r['agent'], 'MALFORMED_CANDIDATE');
  if (!agent.ok) return agent;
  const quantity = parseAmount(r['quantity']);
  if (!quantity.ok) return quantity;
  const executionPrice = parsePrice(r['executionPrice']);
  if (!executionPrice.ok) return executionPrice;
  const notional = parseAmount(r['notional']);
  if (!notional.ok) return notional;
  const referenceStateId = parseIdentifier(r['referenceStateId']);
  if (!referenceStateId.ok) return referenceStateId;
  const epoch = parseBigInt(r['corporateActionEpoch']);
  if (epoch === undefined) return err('MALFORMED_CANDIDATE');
  if (epoch < 0n || epoch > UINT64_MAX) return err('VALUE_OUT_OF_RANGE');

  return ok({
    version,
    representationId: representationId.value,
    canonicalAsset: canonicalAsset.value,
    issuer: issuer.value,
    chain: chain.value,
    venue: venue.value,
    side: side as Side,
    agent: agent.value,
    quantity: quantity.value,
    executionPrice: executionPrice.value,
    notional: notional.value,
    referenceStateId: referenceStateId.value,
    corporateActionEpoch: epoch,
  });
}
