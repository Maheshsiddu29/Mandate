/**
 * Identifier strings and the canonical-asset reference.
 *
 * Every string a mandate carries is an identifier, never prose (design section
 * 7.4, rule 3). Identifiers are restricted to a pure-ASCII charset so that
 * Unicode normalization cannot produce two byte strings for one identifier —
 * the ambiguity is removed rather than resolved (ADR 0002).
 *
 * Nothing here repairs input. A string outside the charset is rejected; it is
 * never trimmed, case-folded, escaped or truncated, because auto-correcting a
 * security-relevant identifier hides the fact that the caller did not build the
 * object it believed it built.
 */

import { type Result, ok, err } from './result.ts';
import type { ReasonCodeName } from './reason-codes.ts';

/** `A-Z a-z 0-9 . _ - : /` — see ADR 0002. */
const IDENTIFIER_CHARSET = /^[A-Za-z0-9._\-:/]+$/;
const SEPARATORS = new Set(['.', '_', '-', ':', '/']);

export const IDENTIFIER_MAX_LENGTH = 128;

/**
 * Compile-time brand. TypeScript brands are erased at run time and are not a
 * security boundary (ADR 0003); every rule below is therefore also enforced by
 * `parseIdentifier` at run time, and the verifier re-parses what it is handed.
 */
declare const IdentifierBrand: unique symbol;
export type Identifier = string & { readonly [IdentifierBrand]: true };

export function parseIdentifier(raw: unknown): Result<Identifier, ReasonCodeName> {
  if (typeof raw !== 'string') return err('MALFORMED_IDENTIFIER');
  if (raw.length === 0 || raw.length > IDENTIFIER_MAX_LENGTH) return err('MALFORMED_IDENTIFIER');
  if (!IDENTIFIER_CHARSET.test(raw)) return err('MALFORMED_IDENTIFIER');
  const first = raw[0];
  const last = raw[raw.length - 1];
  if (first === undefined || last === undefined) return err('MALFORMED_IDENTIFIER');
  if (SEPARATORS.has(first) || SEPARATORS.has(last)) return err('MALFORMED_IDENTIFIER');
  return ok(raw as Identifier);
}

export function isIdentifier(raw: unknown): raw is Identifier {
  return parseIdentifier(raw).ok;
}

/**
 * Canonical financial asset reference (design section 5.2).
 *
 * It names the financial instrument the outside world recognizes. It carries no
 * chain, no contract and no issuer, and a ticker is never its identity: tickers
 * are reused across venues, reassigned after delistings, and changed by
 * corporate action.
 */
export interface CanonicalAssetId {
  /** `equity`, `treasury`, `bond`, ... The segment that lets the scheme extend beyond equities. */
  readonly assetClass: Identifier;
  /** Which external identifier system establishes identity: `figi`, `isin`, `cusip`, ... */
  readonly idScheme: Identifier;
  /** The value within that scheme. Opaque: nothing parses it to infer behaviour. */
  readonly value: Identifier;
}

export function parseCanonicalAssetId(raw: unknown): Result<CanonicalAssetId, ReasonCodeName> {
  if (typeof raw !== 'object' || raw === null) return err('MALFORMED_IDENTIFIER');
  const r = raw as Record<string, unknown>;
  const assetClass = parseIdentifier(r['assetClass']);
  if (!assetClass.ok) return assetClass;
  const idScheme = parseIdentifier(r['idScheme']);
  if (!idScheme.ok) return idScheme;
  const value = parseIdentifier(r['value']);
  if (!value.ok) return value;
  return ok({ assetClass: assetClass.value, idScheme: idScheme.value, value: value.value });
}

export function canonicalAssetIdEquals(a: CanonicalAssetId, b: CanonicalAssetId): boolean {
  return a.assetClass === b.assetClass && a.idScheme === b.idScheme && a.value === b.value;
}

/** Display form. Never used as identity, never parsed back. */
export function formatCanonicalAssetId(a: CanonicalAssetId): string {
  return `mandate:asset:${a.assetClass}:${a.idScheme}:${a.value}`;
}

/**
 * A tokenized representation reference (design section 5.3): chain plus
 * contract, CAIP-19 shaped. It is an `Identifier`, kept opaque to the kernel —
 * the kernel never parses a contract address out of it, and never acquires one
 * from anywhere but trusted representation state.
 */
export type RepresentationId = Identifier;

/**
 * The chain segment of a CAIP-19-shaped representation identifier — everything
 * before the first `/` — or `undefined` when the identifier has no such shape.
 *
 * This is deliberately the *only* structure the kernel reads out of a
 * representation identifier, and it is not address parsing: the contract half is
 * never touched, and an execution address still originates solely from trusted
 * state (INV-7). The chain half is read because the identifier and the `chain`
 * field beside it are two spellings of one security-critical value, and the
 * verifier reconciles redundant spellings rather than trusting its caller to
 * have kept them in step (`checkRepresentationChain`).
 *
 * Returns `undefined` rather than a repaired value for anything malformed. The
 * caller treats that as an inconsistency, so a shape the registry would never
 * emit fails closed here too.
 */
export function chainSegmentOf(representationId: RepresentationId): string | undefined {
  const slash = representationId.indexOf('/');
  if (slash <= 0) return undefined;
  const chain = representationId.slice(0, slash);
  // One `/` only. A second means this is not the shape the registry produces.
  if (representationId.indexOf('/', slash + 1) !== -1) return undefined;
  return chain;
}
export type IssuerId = Identifier;
export type ChainId = Identifier;
export type VenueId = Identifier;
export type AgentId = Identifier;
