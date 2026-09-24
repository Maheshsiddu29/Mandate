import type { Identifier, UnixSeconds } from '@mandate/kernel';
import { parseRobinhoodDeployment, type RobinhoodDeployment } from './asset.ts';
import { parseFixedDecimal, type FixedDecimal } from './decimal.ts';
import { authoritativeHttpEvidence, ObservationClock, type Evidence } from './evidence.ts';
import { AdapterErrorCode, adapterErr, adapterOk, type AdapterResult } from './result.ts';

export const ROBINHOOD_CORPORATE_ACTIONS_SOURCE = 'robinhood-rhj-corporate-actions' as Identifier;

export const CorporateActionType = {
  FORWARD_SPLIT: 'FORWARD_SPLIT', REVERSE_SPLIT: 'REVERSE_SPLIT', CASH_DIVIDEND: 'CASH_DIVIDEND',
  STOCK_DIVIDEND: 'STOCK_DIVIDEND', SPIN_OFF: 'SPIN_OFF', CASH_MERGER: 'CASH_MERGER',
  STOCK_MERGER: 'STOCK_MERGER', STOCK_AND_CASH_MERGER: 'STOCK_AND_CASH_MERGER', REDEMPTION: 'REDEMPTION',
  NAME_CHANGE: 'NAME_CHANGE', WORTHLESS_REMOVAL: 'WORTHLESS_REMOVAL', RIGHTS_DISTRIBUTION: 'RIGHTS_DISTRIBUTION',
  UNIT_SPLIT: 'UNIT_SPLIT', UNKNOWN: 'UNKNOWN',
} as const;
export type CorporateActionType = (typeof CorporateActionType)[keyof typeof CorporateActionType];

export const CorporateActionStatus = { IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED', UNKNOWN: 'UNKNOWN' } as const;
export type CorporateActionStatus = (typeof CorporateActionStatus)[keyof typeof CorporateActionStatus];

export interface ProcessDate { readonly year: number; readonly month: number; readonly day: number }

export interface CorporateActionField {
  readonly name: string;
  readonly value: string | FixedDecimal;
}

export interface NormalizedCorporateAction {
  /** The API currently repeats Stock Token UID here; it is not assumed to be a unique event id. */
  readonly assetUid: Evidence<string>;
  readonly tokenSymbol: Evidence<string>;
  readonly deployments: Evidence<readonly RobinhoodDeployment[]>;
  readonly type: Evidence<CorporateActionType>;
  readonly rawType: string;
  readonly status: Evidence<CorporateActionStatus>;
  readonly processDate: Evidence<ProcessDate | null>;
  readonly details: Evidence<readonly CorporateActionField[]>;
  /** False for future enum values. Such rows are retained for audit and never drive a decision. */
  readonly supportedForDecision: boolean;
}

interface TypeSpec { readonly type: Exclude<CorporateActionType, 'UNKNOWN'>; readonly key: string; readonly rates: readonly string[]; readonly symbols: readonly string[] }

const TYPE_SPECS: Readonly<Record<string, TypeSpec>> = {
  CORPORATE_ACTION_TYPE_FORWARD_SPLIT: { type: CorporateActionType.FORWARD_SPLIT, key: 'forwardSplit', rates: ['oldRate', 'newRate'], symbols: ['underlyingSymbol'] },
  CORPORATE_ACTION_TYPE_REVERSE_SPLIT: { type: CorporateActionType.REVERSE_SPLIT, key: 'reverseSplit', rates: ['oldRate', 'newRate'], symbols: ['underlyingSymbol'] },
  CORPORATE_ACTION_TYPE_CASH_DIVIDEND: { type: CorporateActionType.CASH_DIVIDEND, key: 'cashDividend', rates: ['rate'], symbols: ['underlyingSymbol'] },
  CORPORATE_ACTION_TYPE_STOCK_DIVIDEND: { type: CorporateActionType.STOCK_DIVIDEND, key: 'stockDividend', rates: ['rate'], symbols: ['underlyingSymbol'] },
  CORPORATE_ACTION_TYPE_SPIN_OFF: { type: CorporateActionType.SPIN_OFF, key: 'spinOff', rates: ['sourceRate', 'newRate'], symbols: ['sourceUnderlyingSymbol', 'newUnderlyingSymbol'] },
  CORPORATE_ACTION_TYPE_CASH_MERGER: { type: CorporateActionType.CASH_MERGER, key: 'cashMerger', rates: ['cashRate'], symbols: ['acquireeUnderlyingSymbol'] },
  CORPORATE_ACTION_TYPE_STOCK_MERGER: { type: CorporateActionType.STOCK_MERGER, key: 'stockMerger', rates: ['acquirerRate', 'acquireeRate'], symbols: ['acquirerUnderlyingSymbol', 'acquireeUnderlyingSymbol'] },
  CORPORATE_ACTION_TYPE_STOCK_AND_CASH_MERGER: { type: CorporateActionType.STOCK_AND_CASH_MERGER, key: 'stockAndCashMerger', rates: ['acquirerRate', 'acquireeRate', 'cashRate'], symbols: ['acquirerUnderlyingSymbol', 'acquireeUnderlyingSymbol'] },
  CORPORATE_ACTION_TYPE_REDEMPTION: { type: CorporateActionType.REDEMPTION, key: 'redemption', rates: ['rate'], symbols: ['underlyingSymbol'] },
  CORPORATE_ACTION_TYPE_NAME_CHANGE: { type: CorporateActionType.NAME_CHANGE, key: 'nameChange', rates: [], symbols: ['oldUnderlyingSymbol', 'newUnderlyingSymbol'] },
  CORPORATE_ACTION_TYPE_WORTHLESS_REMOVAL: { type: CorporateActionType.WORTHLESS_REMOVAL, key: 'worthlessRemoval', rates: [], symbols: ['underlyingSymbol'] },
  CORPORATE_ACTION_TYPE_RIGHTS_DISTRIBUTION: { type: CorporateActionType.RIGHTS_DISTRIBUTION, key: 'rightsDistribution', rates: ['rate'], symbols: ['sourceUnderlyingSymbol', 'newUnderlyingSymbol'] },
  CORPORATE_ACTION_TYPE_UNIT_SPLIT: { type: CorporateActionType.UNIT_SPLIT, key: 'unitSplit', rates: ['oldRate', 'newRate', 'alternateRate'], symbols: ['oldUnderlyingSymbol', 'newUnderlyingSymbol', 'alternateUnderlyingSymbol'] },
};

function objectAt(raw: unknown, path: string): AdapterResult<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, path, 'expected object');
  return adapterOk(raw as Record<string, unknown>);
}

function parseDate(raw: unknown, path: string): AdapterResult<ProcessDate | null> {
  if (raw === null || raw === undefined) return adapterOk(null);
  const object = objectAt(raw, path);
  if (!object.ok) return object;
  const { year, month, day } = object.value;
  if (typeof year !== 'number' || typeof month !== 'number' || typeof day !== 'number' ||
      !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
      year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return adapterErr(AdapterErrorCode.INVALID_TIMESTAMP, path, 'invalid process date');
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return adapterErr(AdapterErrorCode.INVALID_TIMESTAMP, path, 'nonexistent process date');
  }
  return adapterOk({ year, month, day });
}

function parseStatus(raw: unknown, path: string): AdapterResult<CorporateActionStatus> {
  if (raw === 'CORPORATE_ACTION_STATUS_IN_PROGRESS') return adapterOk(CorporateActionStatus.IN_PROGRESS);
  if (raw === 'CORPORATE_ACTION_STATUS_COMPLETED') return adapterOk(CorporateActionStatus.COMPLETED);
  if (raw === 'CORPORATE_ACTION_STATUS_UNSPECIFIED') return adapterOk(CorporateActionStatus.UNKNOWN);
  return adapterErr(AdapterErrorCode.UNKNOWN_ENUM, path, `unknown corporate-action status: ${String(raw)}`);
}

export function parseCorporateAction(raw: unknown, fetchedAtUnixSeconds: UnixSeconds, path: string): AdapterResult<NormalizedCorporateAction> {
  const object = objectAt(raw, path);
  if (!object.ok) return object;
  const record = object.value;
  if (typeof record['id'] !== 'string' || !/^0x[0-9a-f]{64}$/.test(record['id'])) return adapterErr(AdapterErrorCode.INVALID_IDENTITY, `${path}.id`, 'invalid asset UID');
  if (typeof record['tokenSymbol'] !== 'string' || !/^[A-Z0-9.\-]{1,16}$/.test(record['tokenSymbol'])) return adapterErr(AdapterErrorCode.INVALID_IDENTITY, `${path}.tokenSymbol`, 'invalid token symbol');
  const deploymentsRaw = record['deployments'];
  if (!Array.isArray(deploymentsRaw) || deploymentsRaw.length === 0) return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, `${path}.deployments`, 'deployment required');
  const deployments: RobinhoodDeployment[] = [];
  for (let index = 0; index < deploymentsRaw.length; index += 1) {
    const parsed = parseRobinhoodDeployment(deploymentsRaw[index], `${path}.deployments[${index}]`);
    if (!parsed.ok) return parsed;
    deployments.push(parsed.value);
  }
  if (typeof record['type'] !== 'string') return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, `${path}.type`, 'type required');
  const rawType = record['type'];
  const spec = TYPE_SPECS[rawType];
  const status = parseStatus(record['status'], `${path}.status`);
  if (!status.ok) return status;
  const processDate = parseDate(record['processDate'], `${path}.processDate`);
  if (!processDate.ok) return processDate;
  const detailsObject = objectAt(record['details'], `${path}.details`);
  if (!detailsObject.ok) return detailsObject;
  let type: CorporateActionType = CorporateActionType.UNKNOWN;
  let supportedForDecision = false;
  const fields: CorporateActionField[] = [];
  if (spec === undefined) {
    // Preserve the type label and field names, but no unreviewed value can become
    // a supported action or influence epoch derivation.
    for (const key of Object.keys(detailsObject.value).sort()) fields.push({ name: `unknown:${key}`, value: 'UNKNOWN' });
  } else {
    type = spec.type;
    supportedForDecision = true;
    if (Object.keys(detailsObject.value).length !== 1 || !(spec.key in detailsObject.value)) {
      return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, `${path}.details`, 'details variant does not match type');
    }
    const variant = objectAt(detailsObject.value[spec.key], `${path}.details.${spec.key}`);
    if (!variant.ok) return variant;
    const expected = new Set([...spec.rates, ...spec.symbols]);
    if (Object.keys(variant.value).some((key) => !expected.has(key)) || Object.keys(variant.value).length !== expected.size) {
      return adapterErr(AdapterErrorCode.MALFORMED_RESPONSE, `${path}.details.${spec.key}`, 'details fields do not match type');
    }
    for (const name of spec.symbols) {
      const value = variant.value[name];
      if (typeof value !== 'string' || !/^[A-Z0-9.\-]{1,16}$/.test(value)) return adapterErr(AdapterErrorCode.INVALID_IDENTITY, `${path}.details.${spec.key}.${name}`, 'invalid underlying symbol');
      fields.push({ name, value });
    }
    for (const name of spec.rates) {
      const value = parseFixedDecimal(variant.value[name], 18, `${path}.details.${spec.key}.${name}`);
      if (!value.ok) return value;
      fields.push({ name, value: value.value });
    }
  }
  const ev = <T>(value: T): Evidence<T> => authoritativeHttpEvidence(
    value, ROBINHOOD_CORPORATE_ACTIONS_SOURCE, fetchedAtUnixSeconds, ObservationClock.HTTP_RETRIEVAL_TIME,
  );
  return adapterOk({
    assetUid: ev(record['id']), tokenSymbol: ev(record['tokenSymbol']), deployments: ev(deployments),
    type: ev(type), rawType, status: ev(status.value), processDate: ev(processDate.value), details: ev(fields), supportedForDecision,
  });
}

export function parseCorporateActionsResponse(raw: unknown, fetchedAtUnixSeconds: UnixSeconds): AdapterResult<readonly NormalizedCorporateAction[]> {
  const response = objectAt(raw, 'response');
  if (!response.ok) return response;
  const rows = response.value['corpActions'];
  if (!Array.isArray(rows)) return adapterErr(AdapterErrorCode.MISSING_REQUIRED_FIELD, 'response.corpActions', 'expected corporate actions array');
  const out: NormalizedCorporateAction[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const parsed = parseCorporateAction(rows[index], fetchedAtUnixSeconds, `response.corpActions[${index}]`);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return adapterOk(out);
}
