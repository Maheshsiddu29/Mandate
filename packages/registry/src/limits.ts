/**
 * Resource bounds for everything the registry parses.
 *
 * Every one of these matches the width of the count its encoder writes. That is
 * the whole rule, and it exists because the architecture pressure test found
 * three collections whose parsers accepted more than `registrySnapshotDigest`
 * could represent: the digest then threw from a `u16` range assertion instead of
 * the parser returning a typed rejection, which broke totality at exactly the
 * boundary where an external caller controls the size.
 *
 * A bound lives here rather than beside its parser so that the relationship to
 * the encoder is stated once and a new collection has an obvious place to
 * declare itself.
 */

/** `u16`, the count the registry encoder writes for every collection it counts. */
export const MAX_SNAPSHOT_ENTRIES = 65_535;

/** Claims about one property of one representation. Same encoder width. */
export const MAX_CLAIMS_PER_PROPERTY = 65_535;
