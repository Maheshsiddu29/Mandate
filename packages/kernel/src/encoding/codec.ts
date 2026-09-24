/**
 * MCE v1 object codecs (ADR 0002).
 *
 * Encoding and decoding are paired and tested as a round-trip in both
 * directions. `decode(encode(x)) == x` proves the decoder reads what the
 * encoder wrote; `encode(decode(b)) == b` is the one that proves canonicality,
 * because if two byte strings decoded to the same value, re-encoding would
 * reveal it.
 *
 * Enum wire codes are frozen. They are written out explicitly rather than
 * derived from declaration order, because a reordered `const` object must never
 * silently change what a signed digest means.
 */

import { type Result, ok, err } from '../result.ts';
import type { ReasonCodeName } from '../reason-codes.ts';
import { ByteWriter, writeIdentifierSet } from './writer.ts';
import { ByteReader } from './reader.ts';
import { bytes32ToBytes, bytesToHex, parseBytes32 } from '../bytes.ts';
import { parseIdentifier } from '../identifiers.ts';
import type { CanonicalAssetId } from '../identifiers.ts';
import type { Amount, Price } from '../units.ts';
import {
  HaltPolicy,
  MANDATE_SCHEMA_VERSION,
  Side,
  SyntheticPolicy,
  parseMandate,
  type CanonicalMandate,
  type PartyId,
} from '../mandate.ts';
import { CANDIDATE_SCHEMA_VERSION, parseCandidate, type ExecutionCandidate } from '../candidate.ts';
import {
  HaltStatus,
  OperationalState,
  ReplayStatus,
  STATE_SCHEMA_VERSION,
  TriState,
  parseTrustedState,
  type TrustedState,
} from '../state.ts';
import { TrustClass, type Observed, type Provenance } from '../trust.ts';

export const DomainTag = {
  MANDATE: 'MANDATE.MANDATE.V1',
  CANDIDATE: 'MANDATE.CANDIDATE.V1',
  STATE: 'MANDATE.STATE.V1',
  AUTHZ: 'MANDATE.AUTHZ.V1',
  RECEIPT: 'MANDATE.RECEIPT.V1',
} as const;

// --- Frozen wire codes ------------------------------------------------------

const SIDE_CODE: Record<string, number> = { BUY: 1, SELL: 2 };
const SIDE_BY_CODE: Record<number, string> = { 1: 'BUY', 2: 'SELL' };

const SYNTHETIC_POLICY_CODE: Record<string, number> = { FORBIDDEN: 1, ALLOWED: 2 };
const SYNTHETIC_POLICY_BY_CODE: Record<number, string> = { 1: 'FORBIDDEN', 2: 'ALLOWED' };

const HALT_POLICY_CODE: Record<string, number> = { FORBID_WHEN_HALTED: 1, ALLOW_WHEN_HALTED: 2 };
const HALT_POLICY_BY_CODE: Record<number, string> = { 1: 'FORBID_WHEN_HALTED', 2: 'ALLOW_WHEN_HALTED' };

const TRISTATE_CODE: Record<string, number> = { NO: 1, YES: 2, UNKNOWN: 3 };
const TRISTATE_BY_CODE: Record<number, string> = { 1: 'NO', 2: 'YES', 3: 'UNKNOWN' };

const OPERATIONAL_CODE: Record<string, number> = { ACTIVE: 1, PAUSED: 2, TRANSITION: 3, DEPRECATED: 4, UNKNOWN: 5 };
const OPERATIONAL_BY_CODE: Record<number, string> = { 1: 'ACTIVE', 2: 'PAUSED', 3: 'TRANSITION', 4: 'DEPRECATED', 5: 'UNKNOWN' };

const HALT_STATUS_CODE: Record<string, number> = { TRADING: 1, HALTED: 2, UNKNOWN: 3 };
const HALT_STATUS_BY_CODE: Record<number, string> = { 1: 'TRADING', 2: 'HALTED', 3: 'UNKNOWN' };

const REPLAY_STATUS_CODE: Record<string, number> = { UNUSED: 1, CONSUMED: 2, UNKNOWN: 3 };
const REPLAY_STATUS_BY_CODE: Record<number, string> = { 1: 'UNUSED', 2: 'CONSUMED', 3: 'UNKNOWN' };

const TRUST_CLASS_CODE: Record<string, number> = { AUTHORITATIVE: 1, VERIFIED: 2, ADVISORY: 3, UNTRUSTED: 4 };
const TRUST_CLASS_BY_CODE: Record<number, string> = { 1: 'AUTHORITATIVE', 2: 'VERIFIED', 3: 'ADVISORY', 4: 'UNTRUSTED' };

/** Presence flag for a nullable field. `0` is absent, `1` is present; nothing else decodes. */
const ABSENT = 0;
const PRESENT = 1;

// --- Shared component writers ----------------------------------------------

function writeParty(w: ByteWriter, p: PartyId): void {
  w.str(p.kind).str(p.value);
}

function writeAsset(w: ByteWriter, a: CanonicalAssetId): void {
  w.str(a.assetClass).str(a.idScheme).str(a.value);
}

function writeAmount(w: ByteWriter, a: Amount): void {
  w.str(a.unit).u8(a.decimals).u256(a.atoms);
}

function writePrice(w: ByteWriter, p: Price): void {
  w.str(p.numeratorUnit).str(p.denominatorUnit).u8(p.decimals).u256(p.atoms);
}

function writeProvenance(w: ByteWriter, p: Provenance): void {
  const code = TRUST_CLASS_CODE[p.trustClass];
  if (code === undefined) throw new Error(`unknown trust class: ${p.trustClass}`);
  w.u8(code).str(p.sourceId).i64(p.observedAtUnixSeconds);
}

// --- Mandate ----------------------------------------------------------------

export function encodeMandate(m: CanonicalMandate): Uint8Array {
  const w = new ByteWriter();
  w.tag(DomainTag.MANDATE).u16(m.version);
  w.bytes32(bytes32ToBytes(m.mandateId));
  w.u64(m.nonce);
  writeParty(w, m.principal);
  writeParty(w, m.agent);
  writeAsset(w, m.canonicalAsset);
  w.u8(SIDE_CODE[m.side] as number);
  writeAmount(w, m.maxNotional);
  w.u16(m.maxDeviationBps);
  w.u8(SYNTHETIC_POLICY_CODE[m.syntheticPolicy] as number);
  writeIdentifierSet(w, m.allowedIssuers);
  writeIdentifierSet(w, m.allowedChains);
  writeIdentifierSet(w, m.allowedVenues);
  w.u64(m.requiredCorporateActionEpoch);
  w.u32(m.maxPriceAgeSeconds);
  w.u32(m.maxCorporateActionAgeSeconds);
  w.u8(HALT_POLICY_CODE[m.haltPolicy] as number);
  w.i64(m.createdAtUnixSeconds);
  w.i64(m.notBeforeUnixSeconds);
  w.i64(m.expiresAtUnixSeconds);
  return w.finish();
}

/** Reads a set and requires strictly ascending encoded order. Duplicates and misordering both reject. */
function readIdentifierSet(r: ByteReader): string[] | undefined {
  const count = r.u16();
  if (count === undefined) return undefined;
  const out: string[] = [];
  let previous: string | undefined;
  for (let i = 0n; i < count; i += 1n) {
    const s = r.str();
    if (s === undefined) return undefined;
    if (!parseIdentifier(s).ok) return undefined;
    if (previous !== undefined) {
      const order = previous.length !== s.length ? (previous.length < s.length ? -1 : 1) : previous < s ? -1 : previous > s ? 1 : 0;
      if (order >= 0) return undefined;
    }
    previous = s;
    out.push(s);
  }
  return out;
}

export function decodeMandate(bytes: Uint8Array): Result<CanonicalMandate, ReasonCodeName> {
  const r = new ByteReader(bytes);
  if (!r.tag(DomainTag.MANDATE)) return err('MALFORMED_MANDATE');
  const version = r.u16();
  if (version === undefined) return err('MALFORMED_MANDATE');
  if (Number(version) !== MANDATE_SCHEMA_VERSION) return err('UNSUPPORTED_MANDATE_VERSION');

  const mandateIdBytes = r.bytes32();
  if (mandateIdBytes === undefined) return err('MALFORMED_MANDATE');
  const nonce = r.u64();
  const principalKind = r.str();
  const principalValue = r.str();
  const agentKind = r.str();
  const agentValue = r.str();
  const assetClass = r.str();
  const idScheme = r.str();
  const assetValue = r.str();
  const sideCode = r.u8();
  const notionalUnit = r.str();
  const notionalDecimals = r.u8();
  const notionalAtoms = r.u256();
  const maxDeviationBps = r.u16();
  const syntheticCode = r.u8();
  const allowedIssuers = readIdentifierSet(r);
  const allowedChains = readIdentifierSet(r);
  const allowedVenues = readIdentifierSet(r);
  const epoch = r.u64();
  const maxPriceAge = r.u32();
  const maxCaAge = r.u32();
  const haltCode = r.u8();
  const createdAt = r.i64();
  const notBefore = r.i64();
  const expiresAt = r.i64();

  if (
    nonce === undefined || principalKind === undefined || principalValue === undefined ||
    agentKind === undefined || agentValue === undefined || assetClass === undefined ||
    idScheme === undefined || assetValue === undefined || sideCode === undefined ||
    notionalUnit === undefined || notionalDecimals === undefined || notionalAtoms === undefined ||
    maxDeviationBps === undefined || syntheticCode === undefined || allowedIssuers === undefined ||
    allowedChains === undefined || allowedVenues === undefined || epoch === undefined ||
    maxPriceAge === undefined || maxCaAge === undefined || haltCode === undefined || createdAt === undefined ||
    notBefore === undefined || expiresAt === undefined
  ) {
    return err('MALFORMED_MANDATE');
  }
  // Trailing bytes are a different object that happens to start the same way.
  if (!r.exhausted) return err('MALFORMED_MANDATE');

  const side = SIDE_BY_CODE[Number(sideCode)];
  const syntheticPolicy = SYNTHETIC_POLICY_BY_CODE[Number(syntheticCode)];
  const haltPolicy = HALT_POLICY_BY_CODE[Number(haltCode)];
  if (side === undefined || syntheticPolicy === undefined || haltPolicy === undefined) return err('MALFORMED_MANDATE');

  // Re-run the structural parser so the decoded object is subject to exactly the
  // same rules as one supplied directly. There is no second, weaker validation path.
  return parseMandate({
    version: Number(version),
    mandateId: bytesToHex(mandateIdBytes),
    nonce,
    principal: { kind: principalKind, value: principalValue },
    agent: { kind: agentKind, value: agentValue },
    canonicalAsset: { assetClass, idScheme, value: assetValue },
    side,
    maxNotional: { unit: notionalUnit, decimals: Number(notionalDecimals), atoms: notionalAtoms },
    maxDeviationBps,
    syntheticPolicy,
    allowedIssuers,
    allowedChains,
    allowedVenues,
    requiredCorporateActionEpoch: epoch,
    maxPriceAgeSeconds: maxPriceAge,
    maxCorporateActionAgeSeconds: maxCaAge,
    haltPolicy,
    createdAtUnixSeconds: createdAt,
    notBeforeUnixSeconds: notBefore,
    expiresAtUnixSeconds: expiresAt,
  });
}

// --- Execution candidate ----------------------------------------------------

export function encodeCandidate(c: ExecutionCandidate): Uint8Array {
  const w = new ByteWriter();
  w.tag(DomainTag.CANDIDATE).u16(c.version);
  w.str(c.representationId);
  writeAsset(w, c.canonicalAsset);
  w.str(c.issuer).str(c.chain).str(c.venue);
  w.u8(SIDE_CODE[c.side] as number);
  writeParty(w, c.agent);
  writeAmount(w, c.quantity);
  writePrice(w, c.executionPrice);
  writeAmount(w, c.notional);
  w.str(c.referenceStateId);
  w.u64(c.corporateActionEpoch);
  return w.finish();
}

export function decodeCandidate(bytes: Uint8Array): Result<ExecutionCandidate, ReasonCodeName> {
  const r = new ByteReader(bytes);
  if (!r.tag(DomainTag.CANDIDATE)) return err('MALFORMED_CANDIDATE');
  const version = r.u16();
  if (version === undefined || Number(version) !== CANDIDATE_SCHEMA_VERSION) return err('MALFORMED_CANDIDATE');

  const representationId = r.str();
  const assetClass = r.str();
  const idScheme = r.str();
  const assetValue = r.str();
  const issuer = r.str();
  const chain = r.str();
  const venue = r.str();
  const sideCode = r.u8();
  const agentKind = r.str();
  const agentValue = r.str();
  const qtyUnit = r.str();
  const qtyDecimals = r.u8();
  const qtyAtoms = r.u256();
  const priceNum = r.str();
  const priceDen = r.str();
  const priceDecimals = r.u8();
  const priceAtoms = r.u256();
  const notionalUnit = r.str();
  const notionalDecimals = r.u8();
  const notionalAtoms = r.u256();
  const referenceStateId = r.str();
  const epoch = r.u64();

  if (
    representationId === undefined || assetClass === undefined || idScheme === undefined ||
    assetValue === undefined || issuer === undefined || chain === undefined || venue === undefined ||
    sideCode === undefined || agentKind === undefined || agentValue === undefined ||
    qtyUnit === undefined || qtyDecimals === undefined || qtyAtoms === undefined ||
    priceNum === undefined || priceDen === undefined || priceDecimals === undefined ||
    priceAtoms === undefined || notionalUnit === undefined || notionalDecimals === undefined ||
    notionalAtoms === undefined || referenceStateId === undefined || epoch === undefined
  ) {
    return err('MALFORMED_CANDIDATE');
  }
  if (!r.exhausted) return err('MALFORMED_CANDIDATE');

  const side = SIDE_BY_CODE[Number(sideCode)];
  if (side === undefined) return err('MALFORMED_CANDIDATE');

  return parseCandidate({
    version: Number(version),
    representationId,
    canonicalAsset: { assetClass, idScheme, value: assetValue },
    issuer,
    chain,
    venue,
    side,
    agent: { kind: agentKind, value: agentValue },
    quantity: { unit: qtyUnit, decimals: Number(qtyDecimals), atoms: qtyAtoms },
    executionPrice: {
      numeratorUnit: priceNum,
      denominatorUnit: priceDen,
      decimals: Number(priceDecimals),
      atoms: priceAtoms,
    },
    notional: { unit: notionalUnit, decimals: Number(notionalDecimals), atoms: notionalAtoms },
    referenceStateId,
    corporateActionEpoch: epoch,
  });
}

// --- Trusted state ----------------------------------------------------------

function writeObservedHeader(w: ByteWriter, o: Observed<unknown>): void {
  writeProvenance(w, o.provenance);
}

export function encodeTrustedState(s: TrustedState): Uint8Array {
  const w = new ByteWriter();
  w.tag(DomainTag.STATE).u16(s.version);
  w.str(s.stateId);

  // Representations are sorted by id so the digest does not depend on the order
  // an adapter happened to emit them in.
  const reps = [...s.representations].sort((a, b) => {
    const x = a.value.representationId;
    const y = b.value.representationId;
    if (x.length !== y.length) return x.length < y.length ? -1 : 1;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  w.u16(reps.length);
  for (const o of reps) {
    writeObservedHeader(w, o);
    const v = o.value;
    w.str(v.representationId);
    writeAsset(w, v.canonicalAsset);
    w.str(v.issuer).str(v.chain);
    if (v.instrumentType === null) w.u8(ABSENT);
    else w.u8(PRESENT).str(v.instrumentType);
    w.u8(TRISTATE_CODE[v.synthetic] as number);
    w.u8(OPERATIONAL_CODE[v.operationalState] as number);
  }

  if (s.market === null) {
    w.u8(ABSENT);
  } else {
    w.u8(PRESENT);
    writeObservedHeader(w, s.market);
    writeAsset(w, s.market.value.canonicalAsset);
    if (s.market.value.referencePrice === null) w.u8(ABSENT);
    else {
      w.u8(PRESENT);
      writePrice(w, s.market.value.referencePrice);
    }
    w.u8(HALT_STATUS_CODE[s.market.value.haltStatus] as number);
  }

  if (s.corporateAction === null) {
    w.u8(ABSENT);
  } else {
    w.u8(PRESENT);
    writeObservedHeader(w, s.corporateAction);
    writeAsset(w, s.corporateAction.value.canonicalAsset);
    if (s.corporateAction.value.epoch === null) w.u8(ABSENT);
    else w.u8(PRESENT).u64(s.corporateAction.value.epoch);
  }

  if (s.replay === null) {
    w.u8(ABSENT);
  } else {
    w.u8(PRESENT);
    writeObservedHeader(w, s.replay);
    w.bytes32(bytes32ToBytes(s.replay.value.mandateDigest));
    w.u8(REPLAY_STATUS_CODE[s.replay.value.status] as number);
  }

  return w.finish();
}

interface RawObserved {
  readonly provenance: { trustClass: string; sourceId: string; observedAtUnixSeconds: bigint };
  readonly value: unknown;
}

function readProvenance(r: ByteReader): RawObserved['provenance'] | undefined {
  const code = r.u8();
  const sourceId = r.str();
  const observedAt = r.i64();
  if (code === undefined || sourceId === undefined || observedAt === undefined) return undefined;
  const trustClass = TRUST_CLASS_BY_CODE[Number(code)];
  if (trustClass === undefined) return undefined;
  return { trustClass, sourceId, observedAtUnixSeconds: observedAt };
}

function readFlag(r: ByteReader): boolean | undefined {
  const f = r.u8();
  if (f === undefined) return undefined;
  const n = Number(f);
  if (n !== ABSENT && n !== PRESENT) return undefined;
  return n === PRESENT;
}

export function decodeTrustedState(bytes: Uint8Array): Result<TrustedState, ReasonCodeName> {
  const r = new ByteReader(bytes);
  if (!r.tag(DomainTag.STATE)) return err('MALFORMED_TRUSTED_STATE');
  const version = r.u16();
  if (version === undefined || Number(version) !== STATE_SCHEMA_VERSION) return err('MALFORMED_TRUSTED_STATE');
  const stateId = r.str();
  if (stateId === undefined) return err('MALFORMED_TRUSTED_STATE');

  const repCount = r.u16();
  if (repCount === undefined) return err('MALFORMED_TRUSTED_STATE');
  const representations: RawObserved[] = [];
  for (let i = 0n; i < repCount; i += 1n) {
    const provenance = readProvenance(r);
    const representationId = r.str();
    const assetClass = r.str();
    const idScheme = r.str();
    const assetValue = r.str();
    const issuer = r.str();
    const chain = r.str();
    const hasInstrument = readFlag(r);
    if (hasInstrument === undefined) return err('MALFORMED_TRUSTED_STATE');
    const instrumentType = hasInstrument ? r.str() : null;
    const syntheticCode = r.u8();
    const operationalCode = r.u8();
    if (
      provenance === undefined || representationId === undefined || assetClass === undefined ||
      idScheme === undefined || assetValue === undefined || issuer === undefined || chain === undefined ||
      instrumentType === undefined || syntheticCode === undefined || operationalCode === undefined
    ) {
      return err('MALFORMED_TRUSTED_STATE');
    }
    const synthetic = TRISTATE_BY_CODE[Number(syntheticCode)];
    const operationalState = OPERATIONAL_BY_CODE[Number(operationalCode)];
    if (synthetic === undefined || operationalState === undefined) return err('MALFORMED_TRUSTED_STATE');
    representations.push({
      provenance,
      value: {
        representationId,
        canonicalAsset: { assetClass, idScheme, value: assetValue },
        issuer,
        chain,
        instrumentType,
        synthetic,
        operationalState,
      },
    });
  }

  const hasMarket = readFlag(r);
  if (hasMarket === undefined) return err('MALFORMED_TRUSTED_STATE');
  let market: RawObserved | null = null;
  if (hasMarket) {
    const provenance = readProvenance(r);
    const assetClass = r.str();
    const idScheme = r.str();
    const assetValue = r.str();
    const hasPrice = readFlag(r);
    if (hasPrice === undefined) return err('MALFORMED_TRUSTED_STATE');
    let referencePrice: unknown = null;
    if (hasPrice) {
      const numeratorUnit = r.str();
      const denominatorUnit = r.str();
      const decimals = r.u8();
      const atoms = r.u256();
      if (numeratorUnit === undefined || denominatorUnit === undefined || decimals === undefined || atoms === undefined) {
        return err('MALFORMED_TRUSTED_STATE');
      }
      referencePrice = { numeratorUnit, denominatorUnit, decimals: Number(decimals), atoms };
    }
    const haltCode = r.u8();
    if (provenance === undefined || assetClass === undefined || idScheme === undefined || assetValue === undefined || haltCode === undefined) {
      return err('MALFORMED_TRUSTED_STATE');
    }
    const haltStatus = HALT_STATUS_BY_CODE[Number(haltCode)];
    if (haltStatus === undefined) return err('MALFORMED_TRUSTED_STATE');
    market = {
      provenance,
      value: { canonicalAsset: { assetClass, idScheme, value: assetValue }, referencePrice, haltStatus },
    };
  }

  const hasCa = readFlag(r);
  if (hasCa === undefined) return err('MALFORMED_TRUSTED_STATE');
  let corporateAction: RawObserved | null = null;
  if (hasCa) {
    const provenance = readProvenance(r);
    const assetClass = r.str();
    const idScheme = r.str();
    const assetValue = r.str();
    const hasEpoch = readFlag(r);
    if (hasEpoch === undefined) return err('MALFORMED_TRUSTED_STATE');
    const epoch = hasEpoch ? r.u64() : null;
    if (provenance === undefined || assetClass === undefined || idScheme === undefined || assetValue === undefined || epoch === undefined) {
      return err('MALFORMED_TRUSTED_STATE');
    }
    corporateAction = {
      provenance,
      value: { canonicalAsset: { assetClass, idScheme, value: assetValue }, epoch },
    };
  }

  const hasReplay = readFlag(r);
  if (hasReplay === undefined) return err('MALFORMED_TRUSTED_STATE');
  let replay: RawObserved | null = null;
  if (hasReplay) {
    const provenance = readProvenance(r);
    const digest = r.bytes32();
    const statusCode = r.u8();
    if (provenance === undefined || digest === undefined || statusCode === undefined) return err('MALFORMED_TRUSTED_STATE');
    const status = REPLAY_STATUS_BY_CODE[Number(statusCode)];
    if (status === undefined) return err('MALFORMED_TRUSTED_STATE');
    replay = { provenance, value: { mandateDigest: bytesToHex(digest), status } };
  }

  if (!r.exhausted) return err('MALFORMED_TRUSTED_STATE');

  return parseTrustedState({
    version: Number(version),
    stateId,
    representations,
    market,
    corporateAction,
    replay,
  });
}

// Referenced so the frozen wire tables stay in step with the enums they encode;
// the codec test asserts every enum member has a code and every code maps back.
export const WIRE_TABLES = {
  Side: { forward: SIDE_CODE, reverse: SIDE_BY_CODE, values: Side },
  SyntheticPolicy: { forward: SYNTHETIC_POLICY_CODE, reverse: SYNTHETIC_POLICY_BY_CODE, values: SyntheticPolicy },
  HaltPolicy: { forward: HALT_POLICY_CODE, reverse: HALT_POLICY_BY_CODE, values: HaltPolicy },
  TriState: { forward: TRISTATE_CODE, reverse: TRISTATE_BY_CODE, values: TriState },
  OperationalState: { forward: OPERATIONAL_CODE, reverse: OPERATIONAL_BY_CODE, values: OperationalState },
  HaltStatus: { forward: HALT_STATUS_CODE, reverse: HALT_STATUS_BY_CODE, values: HaltStatus },
  ReplayStatus: { forward: REPLAY_STATUS_CODE, reverse: REPLAY_STATUS_BY_CODE, values: ReplayStatus },
  TrustClass: { forward: TRUST_CLASS_CODE, reverse: TRUST_CLASS_BY_CODE, values: TrustClass },
} as const;

export { parseBytes32 };
