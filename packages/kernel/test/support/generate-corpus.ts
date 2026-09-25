/**
 * Decision-vector corpus generator.
 *
 * The corpus is a compatibility contract, not a convenience for these tests.
 * Any future implementation — Solidity, Rust, another TypeScript SDK — must
 * produce the same verdict, the same reason codes and the same digests for
 * every vector, which is how the off-chain verifier and the on-chain gate are
 * kept from drifting apart (design section 10.5).
 *
 * Vectors are self-contained: each is a complete `VerifyRequest` plus the
 * expected result. That is deliberate, so Phase 2 can generate large synthetic
 * execution worlds by emitting more vectors of this same shape, with no change
 * to the kernel and no separate simulation verifier.
 *
 * Run: `npm run corpus:generate`. The output is committed, and
 * `corpus.test.ts` fails if the committed file does not match what this
 * generator produces.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { verify, type VerifyRequest } from '../../src/index.ts';
import {
  AMD,
  EPOCH,
  FOREIGN_CHAIN_REPRESENTATION_ID,
  EXPIRES_AT,
  NOT_BEFORE,
  NOW,
  OTHER_AGENT,
  OTHER_CHAIN,
  OTHER_REGISTRY_SNAPSHOT_DIGEST,
  OTHER_VENUE,
  SYNTHETIC_REPRESENTATION_ID,
  UNAPPROVED_ISSUER,
  UNREGISTERED_REPRESENTATION_ID,
  representationInput,
  syntheticRepresentationInput,
} from './fixtures.ts';
import { buildWorld, type WorldOverrides } from './world.ts';
import { TEST_DOMAIN, TEST_PRIVATE_KEY_2 } from './signing.ts';

export const CORPUS_VERSION = 2;

interface VectorSpec {
  readonly id: string;
  readonly family: string;
  readonly description: string;
  readonly world: WorldOverrides;
}

/**
 * The twenty required families, plus the cases that distinguish codes which are
 * easy to conflate.
 */
const SPECS: readonly VectorSpec[] = [
  { id: 'valid-001', family: 'valid', description: 'A backed representation from an approved issuer, at the reference price, within every bound.', world: {} },
  { id: 'valid-002', family: 'valid', description: 'Synthetic exposure, explicitly permitted by the mandate.', world: { mandate: { syntheticPolicy: 'ALLOWED' }, candidate: { representationId: SYNTHETIC_REPRESENTATION_ID }, representations: [syntheticRepresentationInput()] } },
  { id: 'valid-003', family: 'valid', description: 'Trading halted, with a mandate that explicitly allows execution while halted.', world: { mandate: { haltPolicy: 'ALLOW_WHEN_HALTED' }, state: { market: { value: { haltStatus: 'HALTED' } } } } },

  { id: 'asset-001', family: 'wrong-canonical-asset', description: 'The candidate names a different canonical asset than the mandate authorizes.', world: { candidate: { canonicalAsset: { ...AMD } } } },
  { id: 'asset-002', family: 'wrong-canonical-asset', description: 'The representation is issued against a different underlying.', world: { representations: [representationInput({ value: { canonicalAsset: { ...AMD } } })] } },

  { id: 'repr-001', family: 'wrong-representation', description: 'The representation is not in trusted state at all: an injected or hallucinated address.', world: { candidate: { representationId: UNREGISTERED_REPRESENTATION_ID } } },
  { id: 'repr-002', family: 'wrong-representation', description: 'The candidate misdescribes the issuer of the representation it names.', world: { candidate: { issuer: UNAPPROVED_ISSUER } } },

  { id: 'issuer-001', family: 'issuer-violation', description: 'The representation issuer is outside the mandate allowlist.', world: { candidate: { issuer: UNAPPROVED_ISSUER }, representations: [representationInput({ value: { issuer: UNAPPROVED_ISSUER } })] } },

  { id: 'chain-001', family: 'chain-violation', description: 'The execution chain is outside the mandate allowlist.', world: { candidate: { chain: OTHER_CHAIN }, representations: [representationInput({ value: { chain: OTHER_CHAIN } })] } },
  { id: 'venue-001', family: 'venue-violation', description: 'The execution venue is outside the mandate allowlist.', world: { candidate: { venue: OTHER_VENUE } } },

  { id: 'synthetic-001', family: 'synthetic-violation', description: 'Synthetic exposure offered against a mandate that forbids it. The headline refusal.', world: { candidate: { representationId: SYNTHETIC_REPRESENTATION_ID }, representations: [syntheticRepresentationInput()] } },
  { id: 'synthetic-002', family: 'synthetic-violation', description: 'Synthetic status could not be established; an unknown constrained field fails closed.', world: { representations: [representationInput({ value: { synthetic: 'UNKNOWN' } })] } },

  { id: 'notional-001', family: 'notional-overrun', description: 'Ten times the authorized quantity, honestly priced. Exceeds the maximum notional.', world: { candidate: { quantity: { unit: 'SHARE', decimals: 2, atoms: 10_000n }, notional: { unit: 'USD', decimals: 2, atoms: 1_000_000n } } } },
  { id: 'notional-002', family: 'notional-overrun', description: 'One atom over the maximum notional.', world: { candidate: { quantity: { unit: 'SHARE', decimals: 2, atoms: 1_001n }, notional: { unit: 'USD', decimals: 2, atoms: 100_100n } } } },
  { id: 'notional-003', family: 'notional-boundary', description: 'Exactly at the maximum notional. Permitted.', world: {} },
  { id: 'notional-004', family: 'notional-inconsistent', description: 'Declared notional is ten times quantity times price, but still inside the mandate limit, so only the consistency check catches it.', world: { candidate: { quantity: { unit: 'SHARE', decimals: 2, atoms: 100n }, notional: { unit: 'USD', decimals: 2, atoms: 100_000n } } } },

  { id: 'deviation-001', family: 'price-deviation-boundary', description: 'Exactly 40 bps from the reference, with a 40 bps bound. Permitted.', world: { mandate: { maxNotional: { unit: 'USD', decimals: 2, atoms: 200_000n } }, candidate: { executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_040n }, notional: { unit: 'USD', decimals: 2, atoms: 100_400n } } } },
  { id: 'deviation-002', family: 'price-deviation-boundary', description: 'One atom beyond the 40 bps bound; deviation rounds up, so it is refused.', world: { mandate: { maxNotional: { unit: 'USD', decimals: 2, atoms: 200_000n } }, candidate: { executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_041n }, notional: { unit: 'USD', decimals: 2, atoms: 100_410n } } } },

  { id: 'stale-001', family: 'stale-price', description: 'The reference price observation is one second past the freshness bound.', world: { state: { market: { provenance: { observedAtUnixSeconds: NOW - 61n } } } } },
  { id: 'stale-002', family: 'stale-price', description: 'The observation is timestamped after the evaluation instant; freshness cannot be established.', world: { state: { market: { provenance: { observedAtUnixSeconds: NOW + 1n } } } } },

  { id: 'halt-001', family: 'trading-halt', description: 'The underlying is halted and the mandate forbids execution while halted.', world: { state: { market: { value: { haltStatus: 'HALTED' } } } } },
  { id: 'halt-002', family: 'trading-halt', description: 'Halt status could not be established.', world: { state: { market: { value: { haltStatus: 'UNKNOWN' } } } } },

  { id: 'inactive-001', family: 'inactive-representation', description: 'The representation is issuer-paused.', world: { representations: [representationInput({ value: { operationalState: 'PAUSED' } })] } },
  { id: 'inactive-002', family: 'inactive-representation', description: 'The representation is deprecated.', world: { representations: [representationInput({ value: { operationalState: 'DEPRECATED' } })] } },

  { id: 'corpaction-001', family: 'corporate-action-changed', description: 'A corporate action has advanced the epoch past the one the mandate was authorized under. Reauthorization required.', world: { state: { corporateAction: { value: { epoch: EPOCH + 1n } } }, candidate: { corporateActionEpoch: EPOCH + 1n } } },
  { id: 'corpaction-002', family: 'corporate-action-changed', description: 'The epoch feed is behind the authorization: inconsistent, not changed.', world: { state: { corporateAction: { value: { epoch: EPOCH - 1n } } }, candidate: { corporateActionEpoch: EPOCH - 1n } } },
  { id: 'corpaction-003', family: 'corporate-action-changed', description: 'The epoch could not be established.', world: { state: { corporateAction: { value: { epoch: null } } } } },
  { id: 'corpaction-004', family: 'corporate-action-changed', description: 'Epoch matches, but the observation is older than the corporate-action freshness bound.', world: { state: { corporateAction: { provenance: { observedAtUnixSeconds: NOW - 301n } } } } },
  { id: 'corpaction-005', family: 'corporate-action-changed', description: 'The candidate was constructed against a different epoch than the one observed.', world: { candidate: { corporateActionEpoch: EPOCH + 5n } } },

  { id: 'expiry-001', family: 'expired-mandate', description: 'Evaluated exactly at expiry. Expiry is exclusive: this rejects.', world: { now: EXPIRES_AT, state: { market: { provenance: { observedAtUnixSeconds: EXPIRES_AT } }, corporateAction: { provenance: { observedAtUnixSeconds: EXPIRES_AT } } } } },
  { id: 'expiry-002', family: 'expired-mandate', description: 'Evaluated one second before expiry. Permitted.', world: { now: EXPIRES_AT - 1n, state: { market: { provenance: { observedAtUnixSeconds: EXPIRES_AT - 1n } }, corporateAction: { provenance: { observedAtUnixSeconds: EXPIRES_AT - 1n } } } } },
  { id: 'notyet-001', family: 'not-yet-active-mandate', description: 'Evaluated one second before the not-before time.', world: { now: NOT_BEFORE - 1n, state: { market: { provenance: { observedAtUnixSeconds: NOT_BEFORE - 1n } }, corporateAction: { provenance: { observedAtUnixSeconds: NOT_BEFORE - 1n } } } } },
  { id: 'notyet-002', family: 'not-yet-active-mandate', description: 'Evaluated exactly at the not-before time. Permitted.', world: { now: NOT_BEFORE, state: { market: { provenance: { observedAtUnixSeconds: NOT_BEFORE } }, corporateAction: { provenance: { observedAtUnixSeconds: NOT_BEFORE } } } } },

  { id: 'signature-001', family: 'invalid-signature', description: 'The envelope claims the principal signed; the bytes were produced by another key.', world: { signWith: TEST_PRIVATE_KEY_2, forgeSigner: true } },
  { id: 'signature-002', family: 'invalid-signature', description: 'A valid signature by a party that is not the principal: unauthorized, not invalid.', world: { signWith: TEST_PRIVATE_KEY_2 } },
  { id: 'signature-003', family: 'invalid-signature', description: 'A signature issued for a different EIP-712 domain.', world: { signDomain: { ...TEST_DOMAIN, chainId: 1n } } },
  { id: 'signature-004', family: 'invalid-signature', description: 'An authorization scheme this verifier does not implement.', world: { authorization: { scheme: 'ed25519-solana', signer: { kind: 'eip155-address', value: '0x' + '11'.repeat(20) }, signature: '0x' + '00'.repeat(65), domain: { ...TEST_DOMAIN } } } },
  { id: 'agent-001', family: 'invalid-signature', description: 'The proposing agent is not the agent the mandate authorizes.', world: { candidate: { agent: { ...OTHER_AGENT } } } },

  { id: 'replay-001', family: 'replay', description: 'The mandate has already been consumed.', world: { state: { replay: { value: { status: 'CONSUMED' } } } } },
  { id: 'replay-002', family: 'replay', description: 'The mandate is reserved by an in-flight attempt.', world: { state: { replay: { value: { status: 'RESERVED' } } } } },
  { id: 'replay-003', family: 'replay', description: 'Replay state could not be established; it fails closed rather than defaulting to unused.', world: { state: { replay: { value: { status: 'UNKNOWN' } } } } },
  { id: 'replay-004', family: 'replay', description: 'The replay record is about a different mandate, so it establishes nothing about this one.', world: { state: { replay: { value: { mandateDigest: '0x' + 'ab'.repeat(32) } } } } },

  { id: 'unit-001', family: 'unit-mismatch', description: 'Notional denominated in a currency the mandate does not bound. No implicit conversion.', world: { candidate: { notional: { unit: 'EUR', decimals: 2, atoms: 100_000n } } } },
  { id: 'unit-002', family: 'unit-mismatch', description: 'The execution price is quoted per a different unit than the quantity.', world: { candidate: { executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'TOKEN', decimals: 2, atoms: 10_000n } } } },
  { id: 'unit-003', family: 'unit-mismatch', description: 'Quantity at a different decimal scale, with the notional restated consistently. Permitted: scale is explicit, not implied.', world: { candidate: { quantity: { unit: 'SHARE', decimals: 6, atoms: 10_000_000n } } } },

  { id: 'malformed-001', family: 'malformed-identifier', description: 'An identifier outside the canonical charset. Never repaired.', world: { candidate: { venue: 'venue alpha' } } },
  { id: 'malformed-002', family: 'malformed-identifier', description: 'An identifier with a trailing separator.', world: { candidate: { issuer: 'issuer.alpha.' } } },
  { id: 'malformed-003', family: 'malformed-identifier', description: 'A mandate schema version this verifier does not implement.', world: { mandate: { version: 2 } } },
  { id: 'malformed-004', family: 'malformed-identifier', description: 'Trusted state that is structurally wrong.', world: { state: { representations: 'not-an-array' } } },
  { id: 'malformed-005', family: 'malformed-identifier', description: 'A negative quantity, which is not representable.', world: { candidate: { quantity: { unit: 'SHARE', decimals: 2, atoms: -1n } } } },

  { id: 'trust-001', family: 'untrusted-state', description: 'Market state carrying advisory provenance cannot satisfy a trusted input.', world: { state: { market: { provenance: { trustClass: 'ADVISORY' } } } } },
  { id: 'trust-002', family: 'untrusted-state', description: 'Market state carrying untrusted provenance.', world: { state: { market: { provenance: { trustClass: 'UNTRUSTED' } } } } },
  { id: 'trust-003', family: 'untrusted-state', description: 'Required trusted state absent entirely.', world: { state: { market: null } } },

  { id: 'maxvalue-001', family: 'maximum-size-values', description: 'Maximum uint64 nonce and corporate-action epoch, maximum uint16 deviation bound.', world: { mandate: { nonce: (2n ** 64n - 1n), requiredCorporateActionEpoch: (2n ** 64n - 1n), maxDeviationBps: 65_535n }, state: { corporateAction: { value: { epoch: (2n ** 64n - 1n) } } }, candidate: { corporateActionEpoch: (2n ** 64n - 1n) } } },
  { id: 'maxvalue-002', family: 'maximum-size-values', description: 'The maximum supported decimal scale (38) with very large atom counts, exercising exact bigint arithmetic on the permitted path.', world: { mandate: { maxNotional: { unit: 'USD', decimals: 38, atoms: (10n ** 60n) } }, candidate: { quantity: { unit: 'SHARE', decimals: 38, atoms: (10n ** 40n) }, executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_000n }, notional: { unit: 'USD', decimals: 38, atoms: (10n ** 42n) } } } },
  { id: 'maxvalue-003', family: 'maximum-size-values', description: 'An atom count one above the uint256 maximum, which must not wrap.', world: { candidate: { notional: { unit: 'USD', decimals: 2, atoms: (2n ** 256n) } } } },

  { id: 'multi-001', family: 'multiple-violations', description: 'Four independent violations at once. All must be reported, not just the first.', world: { candidate: { issuer: UNAPPROVED_ISSUER, venue: OTHER_VENUE, quantity: { unit: 'SHARE', decimals: 2, atoms: 10_000n }, notional: { unit: 'USD', decimals: 2, atoms: 1_000_000n } }, representations: [representationInput({ value: { issuer: UNAPPROVED_ISSUER } })], state: { market: { provenance: { observedAtUnixSeconds: NOW - 3600n } } } } },
  // --- Phase 5R: the families the remediation introduced --------------------
  { id: 'economic-001', family: 'economic-limit', description: 'BUY at the signed maximum total debit exactly: notional plus fees equals the limit.', world: {} },
  { id: 'economic-002', family: 'economic-limit', description: 'BUY one atom of fee past the signed maximum total debit.', world: { candidate: { feeTotal: { unit: 'USD', decimals: 2, atoms: 901n } } } },
  { id: 'economic-003', family: 'economic-limit', description: 'SELL at the signed minimum total credit exactly: notional minus fees equals the floor.', world: { mandate: { side: 'SELL', economicLimit: { unit: 'USD', decimals: 2, atoms: 99_000n } }, candidate: { side: 'SELL', feeTotal: { unit: 'USD', decimals: 2, atoms: 1_000n } } } },
  { id: 'economic-004', family: 'economic-limit', description: 'SELL one atom of fee below the signed minimum total credit.', world: { mandate: { side: 'SELL', economicLimit: { unit: 'USD', decimals: 2, atoms: 99_000n } }, candidate: { side: 'SELL', feeTotal: { unit: 'USD', decimals: 2, atoms: 1_001n } } } },
  { id: 'economic-005', family: 'economic-limit', description: 'SELL whose fees equal the notional: a net debit, refused before any credit comparison.', world: { mandate: { side: 'SELL', economicLimit: { unit: 'USD', decimals: 2, atoms: 1n } }, candidate: { side: 'SELL', feeTotal: { unit: 'USD', decimals: 2, atoms: 100_000n } } } },
  { id: 'economic-006', family: 'economic-limit', description: 'A fee denominated in a unit the notional does not use.', world: { candidate: { feeTotal: { unit: 'EUR', decimals: 2, atoms: 250n } } } },
  { id: 'repchain-001', family: 'representation-chain', description: 'A contract on a chain the mandate forbids, presented with an allowed chain in the field beside it.', world: { candidate: { representationId: FOREIGN_CHAIN_REPRESENTATION_ID }, representations: [representationInput({ value: { representationId: FOREIGN_CHAIN_REPRESENTATION_ID } })] } },
  { id: 'repchain-002', family: 'representation-chain', description: 'A candidate whose chain field disagrees with the chain inside its own representation identifier.', world: { candidate: { chain: 'eip155:1' } } },
  { id: 'binding-001', family: 'state-binding', description: 'A candidate committing to a registry snapshot that the trusted state does not declare. Structural authority is bound by equality (ADR 0017).', world: { candidate: { registrySnapshotDigest: OTHER_REGISTRY_SNAPSHOT_DIGEST } } },
  { id: 'binding-002', family: 'state-binding', description: 'A trusted state that declares no registry snapshot at all, so the structural binding cannot be established.', world: { state: { registrySnapshotDigest: null } } },
  { id: 'binding-003', family: 'state-binding', description: 'Evaluation-state provenance naming a different world. Committed for audit, never compared against the state being verified, so this is permitted.', world: { candidate: { evaluationStateId: 'snapshot.9999', evaluationStateDigest: '0x' + 'ab'.repeat(32) }, unboundState: true } },
  { id: 'binding-004', family: 'state-binding', description: 'State re-observed five seconds later with a reference price moved inside the mandate bound: a fresh, safe handoff world. Permitted, which whole-state digest equality made impossible.', world: { now: NOW + 5n, state: { stateId: 'snapshot.0002', market: { provenance: { observedAtUnixSeconds: NOW + 5n }, value: { referencePrice: { numeratorUnit: 'USD', denominatorUnit: 'SHARE', decimals: 2, atoms: 10_020n } } }, corporateAction: { provenance: { observedAtUnixSeconds: NOW + 5n } } } } },
  { id: 'replay-005', family: 'replay', description: 'An authorization quarantined after a reservation lapsed with its outcome unestablished.', world: { state: { replay: { value: { status: 'QUARANTINED' } } } } },
];

/** JSON cannot hold a bigint. Decimal strings round-trip exactly through every parser in the kernel. */
function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, toJson(v)]),
    );
  }
  return value;
}

export function buildCorpus(): Record<string, unknown> {
  const vectors = SPECS.map((spec) => {
    const request: VerifyRequest = buildWorld(spec.world);
    const receipt = verify(request);
    return {
      id: spec.id,
      family: spec.family,
      description: spec.description,
      input: toJson({
        mandate: request.mandate,
        authorization: request.authorization,
        candidate: request.candidate,
        trustedState: request.trustedState,
        clock: request.clock,
        expectedDomain: request.expectedDomain,
      }),
      expected: toJson({
        decision: receipt.decision,
        reasonCodes: [...receipt.reasonCodes].sort(),
        mandateDigest: receipt.mandateDigest,
        candidateDigest: receipt.candidateDigest,
        trustedStateDigest: receipt.trustedStateDigest,
        receiptDigest: receipt.receiptDigest,
      }),
    };
  });

  const ids = vectors.map((v) => v.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate vector id');

  return {
    corpusVersion: CORPUS_VERSION,
    verifierVersion: 'mandate-kernel/2',
    encoding: 'MCE v2, keccak-256 (docs/adr/0002-canonical-mandate-encoding.md, docs/adr/0014-symmetric-signed-economic-authorization.md)',
    note: 'Integers are decimal strings because JSON has no integer type wide enough. Vectors are self-contained VerifyRequests.',
    vectorCount: vectors.length,
    vectors,
  };
}

export const CORPUS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../corpus/v2/vectors.json');

export function serializeCorpus(): string {
  return `${JSON.stringify(buildCorpus(), null, 2)}\n`;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\u0000')) {
  writeFileSync(CORPUS_PATH, serializeCorpus(), 'utf8');
  process.stdout.write(`wrote ${CORPUS_PATH}\n`);
}
