/**
 * Canonical encodings for the control engine's records (ADR 0020's
 * discipline: `str(tag) ‖ u16(schemaVersion) ‖ body`, big-endian fixed-width
 * integers, explicit wire codes, sets sorted by encoded bytes, keccak-256
 * over the tagged encoding; nothing is hashed as JSON).
 *
 * Every digest a decision commits to — the projection, the invariant
 * results, the charge plan, the authorization itself — is one of these, so
 * the same inputs always give the same bytes (brief §46) and any material
 * change gives different ones (brief §28).
 *
 * The tags are new and live under `mandate-core/v1/control/`; none reuses a
 * Core or ledger tag.
 */

import { ByteWriter } from '@mandate/kernel';
import {
  CORE_SCHEMA_VERSION,
  compareBytes,
  keccakDigest,
  writeDigest,
  writeI256,
  writeQuantityBody,
  writeRatio,
  type Digest32,
  type ModuleRef,
  type StatePayloadDigest,
} from '@mandate/core';
import type { Measure } from './module.ts';

export const ControlTag = {
  /** `H(tag ‖ moduleDigest, payload)`, the state analogue of Core's action payload digest. */
  STATE_PAYLOAD: 'mandate-core/v1/state-payload/',
  CONTEXT: 'mandate-core/v1/control/context',
  STATE_DEPENDENCIES: 'mandate-core/v1/control/state-dependencies',
  PROJECTION: 'mandate-core/v1/control/projection',
  INVARIANT_RESULTS: 'mandate-core/v1/control/invariant-results',
  CHARGE_PLAN: 'mandate-core/v1/control/charge-plan',
  AUTHORIZATION: 'mandate-core/v1/control/authorization',
  REVALIDATION: 'mandate-core/v1/control/revalidation',
  NEVER_ISSUED: 'mandate-core/v1/control/never-issued',
  AGGREGATE_PARAMS: 'mandate-core/v1/control/aggregate-params',
  NARROWING_PROOF: 'mandate-core/v1/control/narrowing-proof',
} as const;
export type ControlTag = (typeof ControlTag)[keyof typeof ControlTag];

export function controlWriter(tag: ControlTag): ByteWriter {
  return new ByteWriter().str(tag).u16(CORE_SCHEMA_VERSION);
}

export function controlDigest<T extends Digest32>(w: ByteWriter): T {
  return keccakDigest<T>(w.finish());
}

/**
 * `statePayloadDigest = H("mandate-core/v1/state-payload/" ‖ moduleDigest, payload)`.
 *
 * The envelope's `payloadDigest` commits to its payload, and the module
 * digest is inside the hashed bytes, so a payload normalized under one module
 * cannot be presented as another's (the state analogue of Core's
 * `actionPayloadDigest`). Encoded as `str(tag) ‖ u16(1) ‖ moduleDigest ‖
 * u32(length) ‖ payload`.
 */
export function statePayloadDigest(module: ModuleRef, payload: Uint8Array): StatePayloadDigest {
  const w = controlWriter(ControlTag.STATE_PAYLOAD);
  writeDigest(w, module.moduleDigest);
  w.u32(payload.length).raw(payload);
  return controlDigest<StatePayloadDigest>(w);
}

const MEASURE_CODE = { QUANTITY: 1, RATIO: 2, TOTAL: 3, FLAG: 4 } as const;

export function writeMeasure(w: ByteWriter, m: Measure): void {
  w.u8(MEASURE_CODE[m.type]);
  switch (m.type) {
    case 'QUANTITY':
      writeQuantityBody(w, m.quantity);
      break;
    case 'RATIO':
      writeRatio(w, m.ratio);
      break;
    case 'TOTAL':
      w.str(m.kind).str(m.unit).u8(m.decimals);
      writeI256(w, m.atoms);
      break;
    case 'FLAG':
      w.u8(m.value ? 1 : 0);
      break;
  }
}

export function writeNullableMeasure(w: ByteWriter, m: Measure | null): void {
  if (m === null) w.u8(0);
  else {
    w.u8(1);
    writeMeasure(w, m);
  }
}

/** Bytes of one item under a writer, for canonical sorting. */
export function bytesOf<T>(write: (w: ByteWriter, item: T) => void, item: T): Uint8Array {
  const w = new ByteWriter();
  write(w, item);
  return w.finish();
}

/** Items in ascending order of their encodings: the canonical order of a set. Duplicates are kept. */
export function sortCanonical<T>(items: readonly T[], write: (w: ByteWriter, item: T) => void): T[] {
  return items
    .map((item) => ({ item, bytes: bytesOf(write, item) }))
    .sort((a, b) => compareBytes(a.bytes, b.bytes))
    .map((x) => x.item);
}

/**
 * A set written in canonical order: each item encoded once, the encodings
 * sorted, then written as they are. Byte-identical to sorting the items and
 * writing each, at half the encoding work.
 */
export function writeCanonicalSet<T>(w: ByteWriter, items: readonly T[], write: (w: ByteWriter, item: T) => void): void {
  const encoded = items.map((item) => bytesOf(write, item)).sort(compareBytes);
  w.u32(encoded.length);
  for (const b of encoded) w.raw(b);
}

/** A sorted, de-duplicated list of digests. */
export function digestSet<T extends Digest32>(items: Iterable<T>): T[] {
  return [...new Set(items)].sort();
}

export function writeDigestList(w: ByteWriter, items: readonly Digest32[]): void {
  w.u32(items.length);
  for (const d of items) writeDigest(w, d);
}

export function writeStrList(w: ByteWriter, items: readonly string[]): void {
  w.u32(items.length);
  for (const s of items) w.str(s);
}
