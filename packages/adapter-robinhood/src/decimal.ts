import { UINT256_MAX } from '@mandate/kernel';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export interface FixedDecimal {
  readonly atoms: bigint;
  readonly decimals: number;
}

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Parse a non-negative external decimal into one exact, caller-selected scale.
 * Exponents, signs, whitespace, excess precision and unsafe JS numbers reject. */
export function parseFixedDecimal(raw: unknown, decimals: number, path: string): AdapterResult<FixedDecimal> {
  if (typeof raw !== 'string' || decimals < 0 || decimals > 38) {
    return adapterErr(AdapterErrorCode.INVALID_DECIMAL, path, 'expected a decimal string at a supported scale');
  }
  const match = DECIMAL.exec(raw);
  if (match === null) return adapterErr(AdapterErrorCode.INVALID_DECIMAL, path, 'decimal is not canonical');
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    return adapterErr(AdapterErrorCode.INVALID_DECIMAL, path, `decimal exceeds ${decimals} fractional digits`);
  }
  const whole = match[1] as string;
  const atoms = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (atoms > UINT256_MAX) return adapterErr(AdapterErrorCode.VALUE_OUT_OF_RANGE, path, 'decimal exceeds uint256');
  return adapterOk({ atoms, decimals });
}

/** Multiply two fixed-point values into `outputDecimals`, requiring exact
 * representability. Safety comparisons never receive a silently rounded value. */
export function multiplyFixedExact(
  left: FixedDecimal,
  right: FixedDecimal,
  outputDecimals: number,
  path = 'multiplier',
): AdapterResult<FixedDecimal> {
  if (outputDecimals < 0 || outputDecimals > 38) {
    return adapterErr(AdapterErrorCode.VALUE_OUT_OF_RANGE, path, 'unsupported output scale');
  }
  const product = left.atoms * right.atoms;
  const shift = left.decimals + right.decimals - outputDecimals;
  let atoms: bigint;
  if (shift >= 0) {
    const divisor = 10n ** BigInt(shift);
    if (product % divisor !== 0n) {
      return adapterErr(AdapterErrorCode.INVALID_DECIMAL, path, 'product is not exactly representable');
    }
    atoms = product / divisor;
  } else {
    atoms = product * 10n ** BigInt(-shift);
  }
  if (atoms > UINT256_MAX) return adapterErr(AdapterErrorCode.VALUE_OUT_OF_RANGE, path, 'product exceeds uint256');
  return adapterOk({ atoms, decimals: outputDecimals });
}

/** Multiply using the truncation toward zero empirically observed in
 * Robinhood's published tokenBid/tokenAsk fields. The name makes the loss of
 * sub-atom precision explicit; callers must not mistake this for exact math. */
export function multiplyFixedFloor(
  left: FixedDecimal,
  right: FixedDecimal,
  outputDecimals: number,
  path = 'multiplier',
): AdapterResult<FixedDecimal> {
  if (outputDecimals < 0 || outputDecimals > 38) {
    return adapterErr(AdapterErrorCode.VALUE_OUT_OF_RANGE, path, 'unsupported output scale');
  }
  const product = left.atoms * right.atoms;
  const shift = left.decimals + right.decimals - outputDecimals;
  const atoms = shift >= 0
    ? product / (10n ** BigInt(shift))
    : product * (10n ** BigInt(-shift));
  if (atoms > UINT256_MAX) return adapterErr(AdapterErrorCode.VALUE_OUT_OF_RANGE, path, 'product exceeds uint256');
  return adapterOk({ atoms, decimals: outputDecimals });
}
