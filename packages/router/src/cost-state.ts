import { parseAmount, parseIdentifier, parseUnixSeconds } from '@mandate/kernel';
import { MAX_TRUSTED_ROUTE_COSTS, type RouteCosts, type RouteExclusion, type TrustedRouteCost } from './types.ts';

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RouteExclusion };

function nullableAmount(raw: unknown): RouteCosts['venueFee'] | undefined {
  if (raw === null) return null;
  const parsed = parseAmount(raw);
  return parsed.ok ? parsed.value : undefined;
}

export function parseTrustedRouteCosts(raw: unknown): ParseResult<ReadonlyMap<string, TrustedRouteCost>> {
  if (!Array.isArray(raw)) return { ok: false, error: { code: 'INPUT_INVALID', detail: { input: 'trustedCosts' } } };
  // Bounded before iteration, like every other externally sized collection in the
  // system: an oversized input is a typed resource-limit refusal rather than work
  // performed and then discarded (finding N-9).
  if (raw.length > MAX_TRUSTED_ROUTE_COSTS) {
    return {
      ok: false,
      error: {
        code: 'RESOURCE_LIMIT_EXCEEDED',
        detail: { input: 'trustedCosts', limit: String(MAX_TRUSTED_ROUTE_COSTS), observed: String(raw.length) },
      },
    };
  }
  const result = new Map<string, TrustedRouteCost>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return invalid(index);
    const value = item as Record<string, unknown>;
    const known = ['routeId', 'costs', 'provenanceSourceId', 'observedAtUnixSeconds'];
    if (Object.keys(value).some((key) => !known.includes(key))) return invalid(index);
    const routeId = parseIdentifier(value['routeId']);
    const source = parseIdentifier(value['provenanceSourceId']);
    const observedAt = parseUnixSeconds(value['observedAtUnixSeconds'], 'MALFORMED_TRUSTED_STATE');
    const costsRaw = value['costs'];
    if (!routeId.ok || !source.ok || !observedAt.ok || typeof costsRaw !== 'object' || costsRaw === null || Array.isArray(costsRaw)) return invalid(index);
    const costsObject = costsRaw as Record<string, unknown>;
    const costNames = ['venueFee', 'executionFee', 'settlementFee', 'routeFee'] as const;
    if (Object.keys(costsObject).some((key) => !costNames.includes(key as typeof costNames[number]))) return invalid(index);
    const venueFee = nullableAmount(costsObject['venueFee']);
    const executionFee = nullableAmount(costsObject['executionFee']);
    const settlementFee = nullableAmount(costsObject['settlementFee']);
    const routeFee = nullableAmount(costsObject['routeFee']);
    if (venueFee === undefined || executionFee === undefined || settlementFee === undefined || routeFee === undefined) return invalid(index);
    if (result.has(routeId.value)) return { ok: false, error: { code: 'DUPLICATE_ROUTE_ID', detail: { routeId: routeId.value, input: 'trustedCosts' } } };
    result.set(routeId.value, {
      routeId: routeId.value,
      costs: { venueFee, executionFee, settlementFee, routeFee },
      provenanceSourceId: source.value,
      observedAtUnixSeconds: observedAt.value,
    });
  }
  return { ok: true, value: result };
}

function invalid(index: number): ParseResult<never> {
  return { ok: false, error: { code: 'INPUT_INVALID', detail: { input: `trustedCosts[${index}]` } } };
}

