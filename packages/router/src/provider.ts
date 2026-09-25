import {
  parseAmount, parseBigInt, parseCanonicalAssetId, parseIdentifier, parsePartyId,
  parsePrice, parseUnixSeconds, Side, UINT64_MAX,
} from '@mandate/kernel';
import {
  FillPolicy, MAX_ROUTE_CANDIDATES, MAX_ROUTE_STEPS, ProviderClass,
  ROUTE_QUOTE_SCHEMA_VERSION, RouteStepKind, type ProviderRouteQuote,
  type RouteCosts, type RouteExclusion, type RouteStep,
} from './types.ts';

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RouteExclusion };

function failure(detail: Readonly<Record<string, string>>): ParseResult<never> {
  return { ok: false, error: { code: 'MALFORMED_PROVIDER_RESPONSE', detail } };
}

function strictObject(raw: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !fields.includes(key))) return undefined;
  return value;
}

function enumValue<T extends string>(raw: unknown, values: Readonly<Record<string, T>>): T | undefined {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(values, raw) ? values[raw] : undefined;
}

function parseNullableAmount(raw: unknown): RouteCosts['venueFee'] | undefined {
  if (raw === null) return null;
  const parsed = parseAmount(raw);
  return parsed.ok ? parsed.value : undefined;
}

function parseCosts(raw: unknown): RouteCosts | undefined {
  const value = strictObject(raw, ['venueFee', 'executionFee', 'settlementFee', 'routeFee']);
  if (value === undefined) return undefined;
  const venueFee = parseNullableAmount(value['venueFee']);
  const executionFee = parseNullableAmount(value['executionFee']);
  const settlementFee = parseNullableAmount(value['settlementFee']);
  const routeFee = parseNullableAmount(value['routeFee']);
  if (venueFee === undefined || executionFee === undefined || settlementFee === undefined || routeFee === undefined) return undefined;
  return { venueFee, executionFee, settlementFee, routeFee };
}

function parseStep(raw: unknown): RouteStep | undefined {
  const value = strictObject(raw, ['kind', 'venue', 'chain', 'representationId']);
  if (value === undefined) return undefined;
  const kind = enumValue(value['kind'], RouteStepKind);
  const venue = parseIdentifier(value['venue']);
  const chain = parseIdentifier(value['chain']);
  const representationId = parseIdentifier(value['representationId']);
  if (kind === undefined || !venue.ok || !chain.ok || !representationId.ok) return undefined;
  return { kind, venue: venue.value, chain: chain.value, representationId: representationId.value };
}

const QUOTE_FIELDS = [
  'version', 'routeId', 'providerId', 'providerClass', 'canonicalAsset', 'representationId',
  'issuer', 'chain', 'venue', 'side', 'agent', 'quantity', 'executionPrice', 'notional',
  'quoteObservedAtUnixSeconds', 'fillPolicy', 'costs', 'steps', 'referenceStateId',
  'corporateActionEpoch',
] as const;

export function parseProviderRouteQuote(raw: unknown, index = 0): ParseResult<ProviderRouteQuote> {
  const path = `routes[${index}]`;
  const value = strictObject(raw, QUOTE_FIELDS);
  if (value === undefined || value['version'] !== ROUTE_QUOTE_SCHEMA_VERSION) return failure({ path });
  const routeId = parseIdentifier(value['routeId']);
  const providerId = parseIdentifier(value['providerId']);
  const providerClass = enumValue(value['providerClass'], ProviderClass);
  const canonicalAsset = parseCanonicalAssetId(value['canonicalAsset']);
  const representationId = parseIdentifier(value['representationId']);
  const issuer = parseIdentifier(value['issuer']);
  const chain = parseIdentifier(value['chain']);
  const venue = parseIdentifier(value['venue']);
  const side = enumValue(value['side'], Side);
  const agent = parsePartyId(value['agent'], 'MALFORMED_CANDIDATE');
  const quantity = parseAmount(value['quantity']);
  const executionPrice = parsePrice(value['executionPrice']);
  const notional = parseAmount(value['notional']);
  const observedAt = parseUnixSeconds(value['quoteObservedAtUnixSeconds'], 'MALFORMED_CANDIDATE');
  const fillPolicy = enumValue(value['fillPolicy'], FillPolicy);
  const costs = parseCosts(value['costs']);
  const referenceStateId = parseIdentifier(value['referenceStateId']);
  const epoch = parseBigInt(value['corporateActionEpoch']);
  const rawSteps = value['steps'];
  if (
    !routeId.ok || !providerId.ok || providerClass === undefined || !canonicalAsset.ok ||
    !representationId.ok || !issuer.ok || !chain.ok || !venue.ok || side === undefined ||
    !agent.ok || !quantity.ok || !executionPrice.ok || !notional.ok || !observedAt.ok ||
    fillPolicy === undefined || costs === undefined || !referenceStateId.ok || epoch === undefined ||
    epoch < 0n || epoch > UINT64_MAX || !Array.isArray(rawSteps) || rawSteps.length === 0 ||
    rawSteps.length > MAX_ROUTE_STEPS
  ) return failure({ path });
  const steps = rawSteps.map(parseStep);
  if (steps.some((step) => step === undefined)) return failure({ path: `${path}.steps` });
  return { ok: true, value: {
    version: ROUTE_QUOTE_SCHEMA_VERSION, routeId: routeId.value, providerId: providerId.value,
    providerClass, canonicalAsset: canonicalAsset.value, representationId: representationId.value,
    issuer: issuer.value, chain: chain.value, venue: venue.value, side, agent: agent.value,
    quantity: quantity.value, executionPrice: executionPrice.value, notional: notional.value,
    quoteObservedAtUnixSeconds: observedAt.value, fillPolicy, costs,
    steps: steps as readonly RouteStep[], referenceStateId: referenceStateId.value,
    corporateActionEpoch: epoch,
  } };
}

export function parseProviderRouteSet(raw: unknown): ParseResult<readonly ProviderRouteQuote[]> {
  if (!Array.isArray(raw)) return failure({ path: 'routes' });
  if (raw.length > MAX_ROUTE_CANDIDATES) return { ok: false, error: { code: 'RESOURCE_LIMIT_EXCEEDED', detail: { limit: String(MAX_ROUTE_CANDIDATES), observed: String(raw.length) } } };
  const parsed: ProviderRouteQuote[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const quote = parseProviderRouteQuote(raw[index], index);
    if (!quote.ok) return quote;
    if (seen.has(quote.value.routeId)) return { ok: false, error: { code: 'DUPLICATE_ROUTE_ID', detail: { routeId: quote.value.routeId } } };
    seen.add(quote.value.routeId);
    parsed.push(quote.value);
  }
  parsed.sort((left, right) => left.routeId < right.routeId ? -1 : left.routeId > right.routeId ? 1 : 0);
  return { ok: true, value: parsed };
}

export interface RouteProvider {
  readonly providerId: string;
  readonly providerClass: ProviderRouteQuote['providerClass'];
  /** Provider results are untrusted until parsed and independently checked. */
  discover(): unknown;
}

/** Invoke one provider and ensure it cannot mislabel another provider's output. */
export function collectProviderRoutes(provider: RouteProvider): ParseResult<readonly ProviderRouteQuote[]> {
  const providerId = parseIdentifier(provider.providerId);
  if (!providerId.ok || !Object.values(ProviderClass).includes(provider.providerClass)) return failure({ path: 'provider' });
  let raw: unknown;
  try {
    raw = provider.discover();
  } catch {
    return failure({ path: 'provider.discover' });
  }
  const parsed = parseProviderRouteSet(raw);
  if (!parsed.ok) return parsed;
  for (const quote of parsed.value) {
    if (quote.providerId !== providerId.value || quote.providerClass !== provider.providerClass) {
      return { ok: false, error: { code: 'PROVIDER_IDENTITY_MISMATCH', detail: { routeId: quote.routeId, field: 'provider' } } };
    }
  }
  return parsed;
}
