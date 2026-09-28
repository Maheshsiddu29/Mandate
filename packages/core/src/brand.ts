/**
 * Compile-time brands.
 *
 * A brand is erased at run time and is not a security boundary (ADR 0003).
 * Every rule a brand stands for is also enforced by the validator that is the
 * only way to produce the branded value. The brand exists so that passing an
 * `ActionId` where an `AuthorityId` is expected, or adding `MARGIN` to
 * `CAPITAL`, fails to compile.
 *
 * Tags accumulate: `Tagged<Tagged<X, 'A'>, 'B'>` carries both. A `MandateId`
 * is therefore usable wherever an `AuthorityId` is, while an arbitrary
 * `AuthorityId` is not a `MandateId`.
 */

declare const TAGS: unique symbol;

export type Tagged<Base, Tag extends string> = Base & { readonly [TAGS]: { readonly [K in Tag]: true } };
