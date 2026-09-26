/**
 * Exact conversion of a signed economic bound into funding-token atoms.
 *
 * Same arithmetic as `MandateExecutionGate.floorToScale` / `ceilToScale`, and
 * the same rounding rule the kernel uses everywhere: the conversion never rounds
 * in the agent's favour. A maximum debit rounds down; a minimum credit rounds up.
 */

export const UINT256_MAX = 2n ** 256n - 1n;

/** `atoms * 10^to / 10^from`, toward zero, saturating at `uint256` max. */
export function floorToScale(atoms: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals >= fromDecimals) {
    const scaled = atoms * 10n ** BigInt(toDecimals - fromDecimals);
    // A bound larger than any uint256 debit is unreachable, so saturating is exact.
    return scaled > UINT256_MAX ? UINT256_MAX : scaled;
  }
  return atoms / 10n ** BigInt(fromDecimals - toDecimals);
}

/** `atoms * 10^to / 10^from`, away from zero; `undefined` beyond `uint256`. */
export function ceilToScale(atoms: bigint, fromDecimals: number, toDecimals: number): bigint | undefined {
  if (toDecimals >= fromDecimals) {
    const scaled = atoms * 10n ** BigInt(toDecimals - fromDecimals);
    return scaled > UINT256_MAX ? undefined : scaled;
  }
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  const q = atoms / divisor;
  return atoms % divisor === 0n ? q : q + 1n;
}
