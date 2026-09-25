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
 *
 * ## Three kinds of commitment (schema v3, ADR 0017)
 *
 * Schema v2 carried one `referenceStateDigest` and the verifier required it to
 * equal the digest of whatever state it was handed. That conflated three
 * different things, and the consequence was that a *fresh* observation — the
 * whole point of re-verifying at execution handoff — always failed
 * `CANDIDATE_STATE_MISMATCH`, because a new observation timestamp changes the
 * state digest. Only replaying the evaluation state could pass, which makes the
 * re-verification a tautology.
 *
 * v3 separates them:
 *
 * - **Evaluation-state provenance.** `evaluationStateId` and
 *   `evaluationStateDigest` record *which* observed world this candidate was
 *   constructed against. They are committed so the construction is auditable and
 *   reproducible. They are deliberately **not** compared against the state being
 *   verified: the verifier sees one instant per call and cannot know whether it
 *   is the evaluation or the handoff.
 * - **Structural authority.** `registrySnapshotDigest` is the registry snapshot
 *   the representation set was derived from. It is *checked*: a candidate built
 *   against one snapshot may not be verified against state derived from another,
 *   and state that declares no snapshot cannot establish the binding at all.
 *   Structural facts do not refresh, so equality is the right rule for them.
 * - **Dynamic facts.** Price, halt status, freshness, epoch and replay status are
 *   not committed as values to be matched. They are re-evaluated against
 *   whatever state the verifier is handed, by the checks that own them. A
 *   handoff state that differs only in observation timestamp and still satisfies
 *   every predicate passes; one carrying a material safety change rejects for
 *   that change's own reason code, not for a digest mismatch.
 *
 * `feeTotal` remains committed so the verifier can bound what the principal
 * actually pays or receives rather than only the gross notional. Fees enforced
 * outside the commitment are fees a future on-chain gate cannot re-assert.
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
import { parseBytes32, type Bytes32 } from './bytes.ts';
import { parsePartyId, Side, UINT64_MAX, type PartyId } from './mandate.ts';

export const CANDIDATE_SCHEMA_VERSION = 3;

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
  /**
   * Every explicit cost of this route, summed, in the notional's unit.
   *
   * Established outside the route provider and cross-checked against it before
   * a candidate is built; the candidate carries the total so the verifier — not
   * the router — decides whether it is within authority.
   */
  readonly feeTotal: Amount;

  /**
   * Label of the trusted-state snapshot this candidate was constructed against.
   *
   * Provenance, not a binding. The caller chooses it freely, so two materially
   * different states can share one label; and a *later* state legitimately has a
   * different label. Nothing compares it to the state being verified.
   */
  readonly evaluationStateId: string;
  /**
   * Digest of the trusted state this candidate was constructed against.
   *
   * Committed so the construction is auditable and reproducible — given the
   * receipt and this digest, an auditor can identify the exact observed world
   * the candidate came out of. It is **not** compared against the state being
   * verified, because fresh state is expected to differ (ADR 0017).
   */
  readonly evaluationStateDigest: Bytes32;
  /**
   * Digest of the registry snapshot the representation set was derived from.
   *
   * The one piece of state provenance that *is* checked for equality, because a
   * registry snapshot is structural rather than dynamic: a different snapshot
   * can rename an issuer, retire a representation or move a contract, and none
   * of that is something a fresh observation is allowed to do silently. The
   * kernel never interprets it — it has no registry types — it only requires the
   * state it is verifying against to declare the same one.
   */
  readonly registrySnapshotDigest: Bytes32;
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
  'feeTotal',
  'evaluationStateId',
  'evaluationStateDigest',
  'registrySnapshotDigest',
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
  const feeTotal = parseAmount(r['feeTotal']);
  if (!feeTotal.ok) return feeTotal;
  const evaluationStateId = parseIdentifier(r['evaluationStateId']);
  if (!evaluationStateId.ok) return evaluationStateId;
  const evaluationStateDigest = parseBytes32(r['evaluationStateDigest'], 'MALFORMED_CANDIDATE');
  if (!evaluationStateDigest.ok) return evaluationStateDigest;
  const registrySnapshotDigest = parseBytes32(r['registrySnapshotDigest'], 'MALFORMED_CANDIDATE');
  if (!registrySnapshotDigest.ok) return registrySnapshotDigest;
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
    feeTotal: feeTotal.value,
    evaluationStateId: evaluationStateId.value,
    evaluationStateDigest: evaluationStateDigest.value,
    registrySnapshotDigest: registrySnapshotDigest.value,
    corporateActionEpoch: epoch,
  });
}
