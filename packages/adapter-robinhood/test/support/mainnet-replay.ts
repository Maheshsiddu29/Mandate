import { readFileSync } from 'node:fs';
import {
  Decision,
  TrustClass,
  keccak256,
  mandateDigest,
  parseMandate,
  verify,
  type VerifyRequest,
  parseTrustedState,
  trustedStateDigest,
} from '@mandate/kernel';
import {
  DataClass,
  REGISTRY_SCHEMA_VERSION,
  RepresentationOperationalStatus,
  deriveRequirements,
  evaluateRepresentation,
  getRepresentation,
  openRegistry,
  registrySnapshotDigest,
  toRepresentationState,
  type RegistrySnapshot,
  type RepresentationDecision,
} from '@mandate/registry';
import {
  ROBINHOOD_ISSUER_ID,
  buildRepresentationRecord,
  mapCanonicalAsset,
  parseMultiplierEvent,
  toCorporateActionState,
  tokenEquivalentPrice,
} from '../../src/index.ts';
import { TEST_PRIVATE_KEY, addressOf, envelopeFor } from '../../../kernel/test/support/signing.ts';
import {
  FIXTURE_BLOCK_TIMESTAMP,
  FIXTURE_SYMBOLS,
  MAINNET_FIXTURE_ROOT,
  expectAdapter,
  loadCanonicalMappings,
  loadMainnetAssets,
  loadMainnetPrice,
  loadMultiplierEventLogs,
  loadOnchainToken,
} from './mainnet-fixture.ts';

export const MAINNET_REPLAY_CORPUS_VERSION = 1;
export const MAINNET_REPLAY_DOMAIN = {
  name: 'Mandate', version: '1', chainId: 4663n,
  verifyingContract: '0x0000000000000000000000000000000000000001',
} as const;
const AGENT = { kind: 'eip155-address', value: '0x2222222222222222222222222222222222222222' } as const;
const VENUE = 'venue.robinhood.replay';
const CHAIN = 'eip155:4663';
const FAKE_REPRESENTATION = 'eip155:4663/erc20:0x1111111111111111111111111111111111111111';

export type ReplayMutation = 'NONE' | 'STALE_PRICE' | 'SYNTHETIC_HALT' | 'SYNTHETIC_INACTIVE' | 'OLD_EPOCH' | 'FAKE_SAME_SYMBOL';

interface ReplaySpec {
  readonly id: string;
  readonly symbol: typeof FIXTURE_SYMBOLS[number];
  readonly mutation: ReplayMutation;
  readonly stateClass: 'RECORDED_MAINNET' | 'RECORDED_MAINNET_WITH_SYNTHETIC_MUTATION';
  readonly description: string;
}

const SPECS: readonly ReplaySpec[] = [
  ...FIXTURE_SYMBOLS.map((symbol) => ({
    id: `mainnet-${symbol.toLowerCase()}-pass`, symbol, mutation: 'NONE' as const,
    stateClass: 'RECORDED_MAINNET' as const,
    description: `${symbol} recorded mainnet state passes through the registry and kernel.`,
  })),
  { id: 'mainnet-aapl-stale', symbol: 'AAPL', mutation: 'STALE_PRICE', stateClass: 'RECORDED_MAINNET', description: 'The recorded AAPL quote rejects when evaluated beyond its signed freshness bound.' },
  { id: 'synthetic-nvda-halt', symbol: 'NVDA', mutation: 'SYNTHETIC_HALT', stateClass: 'RECORDED_MAINNET_WITH_SYNTHETIC_MUTATION', description: 'A clearly labelled halt mutation proves Robinhood halt state reaches the unchanged verifier.' },
  { id: 'synthetic-tsla-inactive', symbol: 'TSLA', mutation: 'SYNTHETIC_INACTIVE', stateClass: 'RECORDED_MAINNET_WITH_SYNTHETIC_MUTATION', description: 'A clearly labelled inactive representation is excluded by registry and rejected by kernel.' },
  { id: 'mainnet-crwd-old-epoch', symbol: 'CRWD', mutation: 'OLD_EPOCH', stateClass: 'RECORDED_MAINNET', description: 'A mandate authorized before CRWD multiplier epoch advancement becomes stale against captured state.' },
  { id: 'adversarial-nvda-same-symbol', symbol: 'NVDA', mutation: 'FAKE_SAME_SYMBOL', stateClass: 'RECORDED_MAINNET_WITH_SYNTHETIC_MUTATION', description: 'An unregistered same-symbol contract cannot acquire Robinhood NVDA identity.' },
];

export interface BuiltReplayWorld {
  readonly spec: ReplaySpec;
  readonly registryInput: Record<string, unknown>;
  readonly registrySnapshot: RegistrySnapshot;
  readonly registryDecision: RepresentationDecision;
  readonly request: VerifyRequest;
}

function buildSnapshot(inactiveSymbol: string | null): Record<string, unknown> {
  const assets = loadMainnetAssets();
  const mappings = loadCanonicalMappings();
  const canonicalRecords = [];
  const representationRecords = [];
  for (const mapping of mappings.mappings) {
    const asset = assets.find((candidate) => candidate.uid.value === mapping.robinhoodUid);
    if (asset === undefined) throw new Error(`missing mapped asset ${mapping.displayTicker}`);
    const mapped = expectAdapter(mapCanonicalAsset(asset, mapping), `${mapping.displayTicker} canonical mapping`);
    canonicalRecords.push(mapped.record);
    if (!FIXTURE_SYMBOLS.some((symbol) => symbol === mapping.displayTicker)) continue;
    const deployment = asset.deployments.value.find((candidate) => candidate.chainId === 4663n);
    if (deployment === undefined) throw new Error(`missing mainnet deployment ${mapping.displayTicker}`);
    const record = expectAdapter(buildRepresentationRecord(asset, mapped.identity, deployment, {
      disclosureObservedAtUnixSeconds: FIXTURE_BLOCK_TIMESTAMP,
    }), `${mapping.displayTicker} representation`);
    const snapshotRecord = { ...record, representationId: record.representationId.value };
    representationRecords.push(mapping.displayTicker === inactiveSymbol ? {
      ...snapshotRecord,
      operationalStatus: [{
        value: RepresentationOperationalStatus.DEPRECATED,
        provenance: {
          trustClass: TrustClass.VERIFIED,
          sourceId: 'synthetic.inactive.world',
          observedAtUnixSeconds: FIXTURE_BLOCK_TIMESTAMP,
        },
      }],
    } : snapshotRecord);
  }
  const input = {
    registrySchemaVersion: REGISTRY_SCHEMA_VERSION,
    snapshotId: inactiveSymbol === null ? 'robinhood-mainnet-20260924' : `robinhood-mainnet-20260924-${inactiveSymbol.toLowerCase()}-inactive`,
    createdAtUnixSeconds: FIXTURE_BLOCK_TIMESTAMP,
    dataClass: inactiveSymbol === null ? DataClass.OBSERVED : DataClass.SYNTHETIC_FIXTURE,
    sourceVersions: [
      { sourceId: 'robinhood-stock-token-api', version: 'observed-2026-09-24' },
      { sourceId: 'mandate-robinhood-adapter', version: 'phase3-v1' },
    ],
    assets: canonicalRecords,
    representations: representationRecords,
  };
  const parsed = openRegistry(input);
  if (!parsed.ok) throw new Error(`registry snapshot failed: ${parsed.error}`);
  return input;
}

function realEpoch(symbol: typeof FIXTURE_SYMBOLS[number], canonicalAsset: Parameters<typeof toCorporateActionState>[0]) {
  const token = loadOnchainToken(symbol);
  const relevant = loadMultiplierEventLogs()
    .map((raw, index) => expectAdapter(parseMultiplierEvent(raw, `events[${index}]`), 'multiplier event'))
    .filter((event) => event.contractAddress === token.contractAddress.value);
  return expectAdapter(toCorporateActionState(canonicalAsset, token, relevant), `${symbol} corporate state`);
}

export function buildReplayWorld(spec: ReplaySpec): BuiltReplayWorld {
  const registryInput = buildSnapshot(spec.mutation === 'SYNTHETIC_INACTIVE' ? spec.symbol : null);
  const opened = openRegistry(registryInput);
  if (!opened.ok) throw new Error(`cannot open replay registry: ${opened.error}`);
  const mapping = loadCanonicalMappings().mappings.find((item) => item.displayTicker === spec.symbol);
  const asset = loadMainnetAssets().find((item) => item.tokenSymbol.value === spec.symbol);
  if (mapping === undefined || asset === undefined) throw new Error(`missing replay inputs for ${spec.symbol}`);
  const mapped = expectAdapter(mapCanonicalAsset(asset, mapping), `${spec.symbol} mapping`);
  const realRecord = opened.value.snapshot.representations.find((record) => record.display.tokenSymbol === spec.symbol);
  if (realRecord === undefined) throw new Error(`missing representation record for ${spec.symbol}`);
  const corporate = realEpoch(spec.symbol, mapped.identity.value);
  const currentEpoch = corporate.value.epoch;
  const requiredEpoch = spec.mutation === 'OLD_EPOCH' ? 0n : currentEpoch;
  const price = loadMainnetPrice(spec.symbol);
  const tokenAsk = expectAdapter(tokenEquivalentPrice(price.underlyingAsk, asset.currentMultiplier), `${spec.symbol} token ask`);
  const now = spec.mutation === 'STALE_PRICE' ? FIXTURE_BLOCK_TIMESTAMP + 61n : FIXTURE_BLOCK_TIMESTAMP;
  const mandateRaw = {
    version: 2,
    mandateId: keccak256(new TextEncoder().encode(spec.id)),
    nonce: 1n,
    principal: { kind: 'eip155-address', value: addressOf(TEST_PRIVATE_KEY) },
    agent: AGENT,
    canonicalAsset: mapped.identity.value,
    side: 'BUY',
    maxNotional: { unit: 'USD', decimals: 18, atoms: tokenAsk.value.atoms * 2n },
    // BUY: the most the principal may be debited, fees included. The replay
    // worlds carry a zero fee, so this is the notional plus the headroom the
    // gross bound already allows.
    economicLimit: { unit: 'USD', decimals: 18, atoms: tokenAsk.value.atoms * 2n },
    maxDeviationBps: 0n,
    syntheticPolicy: 'FORBIDDEN',
    allowedIssuers: [ROBINHOOD_ISSUER_ID],
    allowedChains: [CHAIN],
    allowedVenues: [VENUE],
    requiredCorporateActionEpoch: requiredEpoch,
    maxPriceAgeSeconds: 60n,
    maxCorporateActionAgeSeconds: 300n,
    haltPolicy: 'FORBID_WHEN_HALTED',
    createdAtUnixSeconds: FIXTURE_BLOCK_TIMESTAMP - 60n,
    notBeforeUnixSeconds: FIXTURE_BLOCK_TIMESTAMP - 60n,
    expiresAtUnixSeconds: FIXTURE_BLOCK_TIMESTAMP + 600n,
  };
  const mandate = parseMandate(mandateRaw);
  if (!mandate.ok) throw new Error(`mandate failed: ${mandate.error}`);
  const requirements = deriveRequirements(mandate.value, { nowUnixSeconds: now });
  if (!requirements.ok) throw new Error(`requirements failed: ${requirements.error}`);
  const candidateRepresentation = spec.mutation === 'FAKE_SAME_SYMBOL' ? FAKE_REPRESENTATION : realRecord.representationId.value;
  const registryDecision = evaluateRepresentation(opened.value, requirements.value, candidateRepresentation);
  const bridgeRecord = getRepresentation(opened.value, realRecord.representationId.value);
  if (bridgeRecord === undefined) throw new Error('bridge record missing');
  const representationState = toRepresentationState(bridgeRecord, requirements.value);
  if (!representationState.ok) throw new Error(`bridge failed: ${representationState.error}`);
  const stateId = `${spec.id}.state`;
  const digest = mandateDigest(mandate.value);
  const marketProvenance = spec.mutation === 'SYNTHETIC_HALT'
    ? { trustClass: TrustClass.VERIFIED, sourceId: 'synthetic.halt.world', observedAtUnixSeconds: price.generatedAtUnixSeconds }
    : tokenAsk.provenance;
  const trustedState = {
    version: 2,
    stateId,
    registrySnapshotDigest: registrySnapshotDigest(opened.value.snapshot),
    representations: [representationState.value],
    market: {
      provenance: marketProvenance,
      value: {
        canonicalAsset: mapped.identity.value,
        referencePrice: tokenAsk.value,
        haltStatus: spec.mutation === 'SYNTHETIC_HALT' ? 'HALTED' : price.tradingHalt.value ? 'HALTED' : 'TRADING',
      },
    },
    corporateAction: corporate,
    replay: {
      provenance: { trustClass: TrustClass.VERIFIED, sourceId: 'replay.mainnet.dataset', observedAtUnixSeconds: now },
      value: { mandateDigest: digest, status: 'UNUSED' },
    },
  };
  // Schema v3 records the evaluation state's digest on the candidate for audit
  // and binds the registry snapshot for equality (ADR 0017), so the world
  // computes both rather than naming a snapshot.
  const parsedState = parseTrustedState(trustedState);
  if (!parsedState.ok) throw new Error(`replay state failed: ${parsedState.error}`);
  const stateDigest = trustedStateDigest(parsedState.value);

  const request: VerifyRequest = {
    mandate: mandateRaw,
    authorization: envelopeFor(digest, TEST_PRIVATE_KEY, MAINNET_REPLAY_DOMAIN),
    candidate: {
      version: 3,
      representationId: candidateRepresentation,
      canonicalAsset: mapped.identity.value,
      issuer: ROBINHOOD_ISSUER_ID,
      chain: CHAIN,
      venue: VENUE,
      side: 'BUY',
      agent: AGENT,
      quantity: { unit: 'TOKEN', decimals: 18, atoms: 1_000_000_000_000_000_000n },
      executionPrice: tokenAsk.value,
      notional: { unit: 'USD', decimals: 18, atoms: tokenAsk.value.atoms },
      feeTotal: { unit: 'USD', decimals: 18, atoms: 0n },
      evaluationStateId: stateId,
      evaluationStateDigest: stateDigest,
      registrySnapshotDigest: registrySnapshotDigest(opened.value.snapshot),
      corporateActionEpoch: currentEpoch,
    },
    trustedState,
    clock: { nowUnixSeconds: now },
    expectedDomain: MAINNET_REPLAY_DOMAIN,
  };
  return { spec, registryInput, registrySnapshot: opened.value.snapshot, registryDecision, request };
}

function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, toJson(item)]));
  }
  return value;
}

export function buildMainnetReplayCorpus(): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(`${MAINNET_FIXTURE_ROOT}manifest.json`, 'utf8')) as Record<string, unknown>;
  const vectors = SPECS.map((spec) => {
    const world = buildReplayWorld(spec);
    const receipt = verify(world.request);
    return {
      id: spec.id,
      symbol: spec.symbol,
      stateClass: spec.stateClass,
      mutation: spec.mutation,
      description: spec.description,
      capture: { captureId: manifest['captureId'], blockNumber: '0x4468e5a', blockTimestamp: '2026-09-24T22:36:48Z' },
      canonicalAssetMapping: toJson(loadCanonicalMappings().mappings.find((item) => item.displayTicker === spec.symbol)),
      registrySnapshot: toJson(world.registryInput),
      registryExpected: toJson({
        status: world.registryDecision.status,
        reasonCodes: world.registryDecision.status === 'EXCLUDED' ? world.registryDecision.reasonCodes : [],
        snapshotDigest: registrySnapshotDigest(world.registrySnapshot),
      }),
      input: toJson(world.request),
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
  return {
    corpusVersion: MAINNET_REPLAY_CORPUS_VERSION,
    verifierVersion: 'mandate-kernel/1',
    registrySchemaVersion: 1,
    fixtureManifest: 'packages/adapter-robinhood/test/fixtures/mainnet/2026-09-24/manifest.json',
    note: 'Integers are decimal strings. RECORDED_MAINNET_WITH_SYNTHETIC_MUTATION cases are never claims about observed market events.',
    vectorCount: vectors.length,
    vectors,
  };
}

export function buildMainnetReplayReport(): Record<string, unknown> {
  const corpus = buildMainnetReplayCorpus();
  const vectors = corpus['vectors'] as readonly Record<string, unknown>[];
  const receipts = vectors.map((vector) => vector['expected'] as Record<string, unknown>);
  const rejectionReasons: Record<string, number> = {};
  for (const receipt of receipts) {
    for (const reason of receipt['reasonCodes'] as readonly string[]) rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  }
  return {
    reportVersion: 1,
    captureId: 'robinhood-mainnet-2026-09-24T22-36-48Z',
    assetsCaptured: 195,
    canonicalAssetsMapped: 7,
    representationsVerifiedOnchain: 6,
    marketSnapshots: 6,
    corporateActionsObserved: 52,
    corporateActionTypesObserved: ['CASH_DIVIDEND'],
    verificationRuns: receipts.length,
    pass: receipts.filter((receipt) => receipt['decision'] === Decision.PASS).length,
    reject: receipts.filter((receipt) => receipt['decision'] === Decision.REJECT).length,
    rejectByReason: rejectionReasons,
    crossSurface: { checks: 60, matches: 54, mismatches: 0, timeIncomparable: 5, unavailable: 1 },
    unknownMetadata: ['CRWD Chainlink feed unavailable in captured official catalog'],
    syntheticCases: vectors.filter((vector) => vector['stateClass'] === 'RECORDED_MAINNET_WITH_SYNTHETIC_MUTATION').length,
  };
}
