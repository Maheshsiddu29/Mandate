/**
 * Semantic module and adapter identity (DOM-2, action-state-model.md §8.1,
 * enforcement-adapters.md §2).
 *
 * `(moduleId, moduleVersion)` is a name; `moduleDigest` is the identity. A
 * `ModuleRef` is only ever the full four-field object: there is no shorthand
 * such as `"perp-policy@1"`, and the digest is mandatory and may not be the
 * all-zero placeholder. Two refs that differ only in digest are two different
 * semantic modules, with different encodings and different digests, and so
 * are every action, grant and reservation that names them.
 *
 * `AdapterRef` follows the same rule for enforcement adapters: an adapter
 * whose descriptor or observation rule changes gets a new digest, so a mutable
 * implementation can never silently reuse an identity.
 *
 * The module manifest itself, and the registry that maps a name to exactly one
 * digest and lists conforming implementations, are not built here (open
 * question 16).
 */

import { ok, type ByteWriter } from '@mandate/kernel';
import type { Tagged } from './brand.ts';
import { at, type CoreResult } from './errors.ts';
import type {
  AdapterDigest,
  AdapterId,
  AdapterRefDigest,
  AdapterVersion,
  DomainId,
  ModuleDigest,
  ModuleId,
  ModuleRefDigest,
  ModuleVersion,
} from './identifiers.ts';
import { UINT32_MAX, checkFields, parseIdentifierAs, parseNonZeroDigest, parseSmallUint } from './primitives.ts';
import { CoreTag, decodeTagged, keccakDigest, taggedWriter, writeDigest, type CoreReader } from './encoding.ts';

export interface ModuleRefInput {
  readonly domainId: string;
  readonly moduleId: string;
  readonly moduleVersion: number;
  readonly moduleDigest: string;
}

export type ModuleRef = Tagged<
  {
    readonly domainId: DomainId;
    readonly moduleId: ModuleId;
    /** uint32; any semantic change increments it. */
    readonly moduleVersion: ModuleVersion;
    /** `H("mandate-core/v1/module", ModuleManifest)`. */
    readonly moduleDigest: ModuleDigest;
  },
  'ModuleRef'
>;

export function validateModuleRef(input: ModuleRefInput, path = 'moduleRef'): CoreResult<ModuleRef> {
  const shape = checkFields(input, ['domainId', 'moduleId', 'moduleVersion', 'moduleDigest'], path);
  if (!shape.ok) return shape;
  const domainId = parseIdentifierAs<DomainId>(input.domainId, at(path, 'domainId'));
  if (!domainId.ok) return domainId;
  const moduleId = parseIdentifierAs<ModuleId>(input.moduleId, at(path, 'moduleId'));
  if (!moduleId.ok) return moduleId;
  const moduleVersion = parseSmallUint(input.moduleVersion, UINT32_MAX, at(path, 'moduleVersion'));
  if (!moduleVersion.ok) return moduleVersion;
  const moduleDigest = parseNonZeroDigest<ModuleDigest>(input.moduleDigest, at(path, 'moduleDigest'));
  if (!moduleDigest.ok) return moduleDigest;
  return ok({
    domainId: domainId.value,
    moduleId: moduleId.value,
    moduleVersion: moduleVersion.value as ModuleVersion,
    moduleDigest: moduleDigest.value,
  } as ModuleRef);
}

export function writeModuleRef(w: ByteWriter, m: ModuleRef): void {
  w.str(m.domainId).str(m.moduleId).u32(m.moduleVersion);
  writeDigest(w, m.moduleDigest);
}

export function readModuleRefInput(r: CoreReader): ModuleRefInput {
  const domainId = r.str();
  const moduleId = r.str();
  const moduleVersion = r.u32();
  const moduleDigest = r.digest();
  return { domainId, moduleId, moduleVersion, moduleDigest };
}

export function moduleRefInputOf(m: ModuleRef): ModuleRefInput {
  return { domainId: m.domainId, moduleId: m.moduleId, moduleVersion: m.moduleVersion, moduleDigest: m.moduleDigest };
}

/** Exact equality of all four fields. Equal names with different digests are different modules. */
export function moduleRefsEqual(a: ModuleRef, b: ModuleRef): boolean {
  return a.domainId === b.domainId && a.moduleId === b.moduleId && a.moduleVersion === b.moduleVersion && a.moduleDigest === b.moduleDigest;
}

export function encodeModuleRef(m: ModuleRef): Uint8Array {
  const w = taggedWriter(CoreTag.MODULE_REF);
  writeModuleRef(w, m);
  return w.finish();
}

export function decodeModuleRef(bytes: Uint8Array): CoreResult<ModuleRef> {
  return decodeTagged(bytes, CoreTag.MODULE_REF, readModuleRefInput, (input) => validateModuleRef(input));
}

export function moduleRefDigest(m: ModuleRef): ModuleRefDigest {
  return keccakDigest<ModuleRefDigest>(encodeModuleRef(m));
}

// --- AdapterRef ----------------------------------------------------------------

export interface AdapterRefInput {
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly adapterDigest: string;
}

export type AdapterRef = Tagged<
  {
    readonly adapterId: AdapterId;
    readonly adapterVersion: AdapterVersion;
    /** Content-addresses the adapter's descriptor and observation-rule semantics. */
    readonly adapterDigest: AdapterDigest;
  },
  'AdapterRef'
>;

export function validateAdapterRef(input: AdapterRefInput, path = 'adapterRef'): CoreResult<AdapterRef> {
  const shape = checkFields(input, ['adapterId', 'adapterVersion', 'adapterDigest'], path);
  if (!shape.ok) return shape;
  const adapterId = parseIdentifierAs<AdapterId>(input.adapterId, at(path, 'adapterId'));
  if (!adapterId.ok) return adapterId;
  const adapterVersion = parseSmallUint(input.adapterVersion, UINT32_MAX, at(path, 'adapterVersion'));
  if (!adapterVersion.ok) return adapterVersion;
  const adapterDigest = parseNonZeroDigest<AdapterDigest>(input.adapterDigest, at(path, 'adapterDigest'));
  if (!adapterDigest.ok) return adapterDigest;
  return ok({
    adapterId: adapterId.value,
    adapterVersion: adapterVersion.value as AdapterVersion,
    adapterDigest: adapterDigest.value,
  } as AdapterRef);
}

export function writeAdapterRef(w: ByteWriter, a: AdapterRef): void {
  w.str(a.adapterId).u32(a.adapterVersion);
  writeDigest(w, a.adapterDigest);
}

export function readAdapterRefInput(r: CoreReader): AdapterRefInput {
  const adapterId = r.str();
  const adapterVersion = r.u32();
  const adapterDigest = r.digest();
  return { adapterId, adapterVersion, adapterDigest };
}

export function adapterRefInputOf(a: AdapterRef): AdapterRefInput {
  return { adapterId: a.adapterId, adapterVersion: a.adapterVersion, adapterDigest: a.adapterDigest };
}

export function adapterRefsEqual(a: AdapterRef, b: AdapterRef): boolean {
  return a.adapterId === b.adapterId && a.adapterVersion === b.adapterVersion && a.adapterDigest === b.adapterDigest;
}

export function encodeAdapterRef(a: AdapterRef): Uint8Array {
  const w = taggedWriter(CoreTag.ADAPTER_REF);
  writeAdapterRef(w, a);
  return w.finish();
}

export function decodeAdapterRef(bytes: Uint8Array): CoreResult<AdapterRef> {
  return decodeTagged(bytes, CoreTag.ADAPTER_REF, readAdapterRefInput, (input) => validateAdapterRef(input));
}

export function adapterRefDigest(a: AdapterRef): AdapterRefDigest {
  return keccakDigest<AdapterRefDigest>(encodeAdapterRef(a));
}
