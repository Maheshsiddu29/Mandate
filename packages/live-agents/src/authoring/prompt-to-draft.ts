/**
 * Prompt → draft (docs/demo/live-ai-lab.md §2).
 *
 * The principal's words become a *draft*, never authority. An interpreter —
 * a model through `AgentModelProvider.interpretMandateDraft`, or the
 * deterministic local parser below — returns a `DraftInterpretation` in a
 * strict schema. `draftFromInterpretation` then admits only what the schema
 * and the reviewed catalog allow:
 *
 * - amounts must be exact decimal USDC; anything else stays unset;
 * - set members must be catalog ids; anything else is dropped as UNSUPPORTED;
 * - "synthetic exposure allowed" would widen the reviewed catalog: UNSUPPORTED;
 * - every field the interpretation leaves `null` stays unset and blocks
 *   authorization until the principal sets it.
 *
 * The interpreter may suggest, explain and flag. It cannot sign, activate,
 * widen, or name an address.
 */

import { CATALOG, CATALOG_SETS, catalogIds, type CatalogSet } from './catalog.ts';
import { emptyDraft, fieldAt, ISSUE_KINDS, withField, type DraftIssue, type FieldSource, type IssueKind, type MandateDraft } from './draft-types.ts';
import { MONEY_PATTERN, moneyTextFromMatch, parseShareLanguage, resolveShare, atomsText } from './money-language.ts';
import { ROLES, parseCount, parseUsdc, usdcText, type Role } from '../types.ts';
import { array, bad, boundedText, enumSchema, exactKeys, good, isObject, nullableBoolean, nullableOneOf, nullableString, nullableText, objectSchema, oneOf, parseJsonObject, type JsonObject, type JsonValue, type Parsed } from '../runtime/strict-json.ts';
import type { AgentModelProvider, DraftRequest } from '../runtime/provider.ts';
import { callModel, type CallOutcome } from '../runtime/agent-runtime.ts';
import type { Clock } from '../runtime/clock.ts';

const MARKET_SETS = ['assets', 'issuers', 'representations', 'venues', 'chains'] as const;
type MarketSet = (typeof MARKET_SETS)[number];

export interface DraftInterpretation {
  readonly portfolio: {
    readonly totalCapital: string | null;
    readonly minUnallocated: string | null;
    readonly maxDeployed: string | null;
    readonly deployAll: boolean | null;
    readonly maxDerivative: string | null;
    readonly maxIlliquid: string | null;
    readonly validityMinutes: string | null;
    readonly autoReallocate: boolean | null;
  };
  readonly agents: readonly { readonly role: Role; readonly enabled: boolean | null; readonly maxAllocation: string | null; readonly maxExposure: string | null; readonly budget: string | null }[];
  readonly market: { readonly [S in MarketSet]: readonly string[] | null } & {
    readonly maxLeverage: string | null;
    readonly maxSlippageBps: string | null;
    readonly maxQuoteAgeSeconds: string | null;
    readonly syntheticExposure: 'FORBIDDEN' | 'ALLOWED' | null;
  };
  readonly execution: { readonly recipients: readonly string[] | null };
  readonly issues: readonly DraftIssue[];
  readonly notes: readonly string[];
}

const PORTFOLIO_FIELDS = ['totalCapital', 'minUnallocated', 'maxDeployed', 'deployAll', 'maxDerivative', 'maxIlliquid', 'validityMinutes', 'autoReallocate'] as const;
const PORTFOLIO_BOOLEANS: ReadonlySet<string> = new Set(['deployAll', 'autoReallocate']);
const MAX_ISSUES = 12;
const MAX_NOTES = 8;
const TEXT = 240;

// --- The schema a model must answer in ------------------------------------------------------

function idList(set: CatalogSet): JsonObject {
  return { type: ['array', 'null'], items: { type: 'string', enum: [...catalogIds(set)] } };
}

export const DRAFT_SCHEMA: JsonObject = objectSchema({
  portfolio: objectSchema({
    totalCapital: nullableString(24),
    minUnallocated: nullableString(24),
    maxDeployed: nullableString(24),
    deployAll: { type: ['boolean', 'null'] },
    maxDerivative: nullableString(24),
    maxIlliquid: nullableString(24),
    validityMinutes: nullableString(8),
    autoReallocate: { type: ['boolean', 'null'] },
  }),
  agents: {
    type: 'array',
    items: objectSchema({ role: enumSchema(ROLES), enabled: { type: ['boolean', 'null'] }, maxAllocation: nullableString(24), maxExposure: nullableString(24), budget: nullableString(24) }),
  },
  market: objectSchema({
    assets: idList('assets'),
    issuers: idList('issuers'),
    representations: idList('representations'),
    venues: idList('venues'),
    chains: idList('chains'),
    maxLeverage: nullableString(8),
    maxSlippageBps: nullableString(8),
    maxQuoteAgeSeconds: nullableString(8),
    syntheticExposure: enumSchema(['FORBIDDEN', 'ALLOWED'], true),
  }),
  execution: objectSchema({ recipients: idList('recipients') }),
  issues: { type: 'array', items: objectSchema({ kind: enumSchema(ISSUE_KINDS), field: nullableString(64), text: { type: 'string', maxLength: TEXT } }) },
  notes: { type: 'array', items: { type: 'string', maxLength: TEXT } },
});

export function draftRequest(prompt: string): DraftRequest {
  const catalog: { [set: string]: readonly { readonly id: string; readonly label: string }[] } = {};
  for (const set of CATALOG_SETS) catalog[set] = CATALOG[set].map((e) => ({ id: e.id, label: e.label }));
  return { kind: 'DRAFT', prompt, catalog, roles: ROLES, issueKinds: ISSUE_KINDS };
}

// --- Strict parse ---------------------------------------------------------------------------

function nullableIdList(v: JsonValue | undefined, where: string): Parsed<readonly string[] | null> {
  if (v === null) return good(null);
  const a = array(v, 16, where);
  if (!a.ok) return a;
  const out: string[] = [];
  for (const x of a.value) {
    const t = boundedText(x, 64, where);
    if (!t.ok) return t;
    out.push(t.value);
  }
  return good(out);
}

/** Parse model text into an interpretation: exact shape, or an error. Catalog membership is checked later. */
export function parseDraftInterpretation(text: string): Parsed<DraftInterpretation> {
  const o = parseJsonObject(text);
  if (!o.ok) return o;
  const top = exactKeys(o.value, ['portfolio', 'agents', 'market', 'execution', 'issues', 'notes'], 'draft');
  if (!top.ok) return top;
  const p = o.value['portfolio'];
  if (!isObject(p)) return bad('portfolio: not an object');
  const pk = exactKeys(p, PORTFOLIO_FIELDS, 'portfolio');
  if (!pk.ok) return pk;
  const portfolio: { [k: string]: string | boolean | null } = {};
  for (const f of PORTFOLIO_FIELDS) {
    const r = PORTFOLIO_BOOLEANS.has(f) ? nullableBoolean(p[f], `portfolio.${f}`) : nullableText(p[f], 24, `portfolio.${f}`);
    if (!r.ok) return bad(r.error);
    portfolio[f] = r.value;
  }
  const agentsRaw = array(o.value['agents'], ROLES.length * 2, 'agents');
  if (!agentsRaw.ok) return agentsRaw;
  const agents: DraftInterpretation['agents'][number][] = [];
  for (const a of agentsRaw.value) {
    if (!isObject(a)) return bad('agents: not an object');
    const k = exactKeys(a, ['role', 'enabled', 'maxAllocation', 'maxExposure', 'budget'], 'agents[]');
    if (!k.ok) return k;
    const role = oneOf(a['role'], ROLES, 'agents[].role');
    if (!role.ok) return role;
    const enabled = nullableBoolean(a['enabled'], 'agents[].enabled');
    if (!enabled.ok) return enabled;
    const max = nullableText(a['maxAllocation'], 24, 'agents[].maxAllocation');
    if (!max.ok) return max;
    const exposure = nullableText(a['maxExposure'], 24, 'agents[].maxExposure');
    if (!exposure.ok) return exposure;
    const budget = nullableText(a['budget'], 24, 'agents[].budget');
    if (!budget.ok) return budget;
    agents.push({ role: role.value, enabled: enabled.value, maxAllocation: max.value, maxExposure: exposure.value, budget: budget.value });
  }
  const m = o.value['market'];
  if (!isObject(m)) return bad('market: not an object');
  const mk = exactKeys(m, [...MARKET_SETS, 'maxLeverage', 'maxSlippageBps', 'maxQuoteAgeSeconds', 'syntheticExposure'], 'market');
  if (!mk.ok) return mk;
  const sets: { [k: string]: readonly string[] | null } = {};
  for (const s of MARKET_SETS) {
    const r = nullableIdList(m[s], `market.${s}`);
    if (!r.ok) return r;
    sets[s] = r.value;
  }
  const bounds: { [k: string]: string | null } = {};
  for (const b of ['maxLeverage', 'maxSlippageBps', 'maxQuoteAgeSeconds'] as const) {
    const r = nullableText(m[b], 8, `market.${b}`);
    if (!r.ok) return r;
    bounds[b] = r.value;
  }
  const synthetic = nullableOneOf(m['syntheticExposure'], ['FORBIDDEN', 'ALLOWED'] as const, 'market.syntheticExposure');
  if (!synthetic.ok) return synthetic;
  const e = o.value['execution'];
  if (!isObject(e)) return bad('execution: not an object');
  const ek = exactKeys(e, ['recipients'], 'execution');
  if (!ek.ok) return ek;
  const recipients = nullableIdList(e['recipients'], 'execution.recipients');
  if (!recipients.ok) return recipients;
  const issuesRaw = array(o.value['issues'], MAX_ISSUES, 'issues');
  if (!issuesRaw.ok) return issuesRaw;
  const issues: DraftIssue[] = [];
  for (const i of issuesRaw.value) {
    if (!isObject(i)) return bad('issues: not an object');
    const k = exactKeys(i, ['kind', 'field', 'text'], 'issues[]');
    if (!k.ok) return k;
    const kind = oneOf(i['kind'], ISSUE_KINDS, 'issues[].kind');
    if (!kind.ok) return kind;
    const field = nullableText(i['field'], 64, 'issues[].field');
    if (!field.ok) return field;
    const t = boundedText(i['text'], TEXT, 'issues[].text');
    if (!t.ok) return t;
    issues.push({ kind: kind.value, field: field.value, text: t.value });
  }
  const notesRaw = array(o.value['notes'], MAX_NOTES, 'notes');
  if (!notesRaw.ok) return notesRaw;
  const notes: string[] = [];
  for (const n of notesRaw.value) {
    const t = boundedText(n, TEXT, 'notes[]');
    if (!t.ok) return t;
    notes.push(t.value);
  }
  return good({
    portfolio: portfolio as unknown as DraftInterpretation['portfolio'],
    agents,
    market: { ...(sets as { [S in MarketSet]: readonly string[] | null }), maxLeverage: bounds['maxLeverage'] ?? null, maxSlippageBps: bounds['maxSlippageBps'] ?? null, maxQuoteAgeSeconds: bounds['maxQuoteAgeSeconds'] ?? null, syntheticExposure: synthetic.value },
    execution: { recipients: recipients.value },
    issues,
    notes,
  });
}

// --- Interpretation → draft -------------------------------------------------------------------

function amountText(raw: string | null): string | null {
  if (raw === null) return null;
  const atoms = parseUsdc(raw);
  return atoms === null ? null : usdcText(atoms);
}

/**
 * Admit what an interpretation may set. Anything outside the catalog or the
 * value grammar is dropped and reported; nothing unset is filled in.
 * `source` tags every admitted field (C2.0 provenance).
 */
export function draftFromInterpretation(x: DraftInterpretation, source: FieldSource = 'INTERPRETED'): MandateDraft {
  let d = emptyDraft();
  const issues: DraftIssue[] = [];
  const set = (path: string, value: string | boolean | readonly string[] | null, evidenceText?: string) => {
    if (value !== null) d = withField(d, path, value, source, evidenceText);
  };
  const amount = (path: string, raw: string | null) => {
    const v = amountText(raw);
    if (raw !== null && v === null) issues.push({ kind: 'AMBIGUOUS', field: path, text: `Could not read "${raw.slice(0, 24)}" as a USDC amount; left unset.` });
    set(path, v);
  };
  const count = (path: string, raw: string | null, max: number) => {
    if (raw === null) return;
    const n = parseCount(raw, max);
    if (n === null) issues.push({ kind: 'AMBIGUOUS', field: path, text: `Could not read "${raw.slice(0, 24)}" as a whole number up to ${max}; left unset.` });
    else set(path, String(n));
  };

  for (const f of ['totalCapital', 'minUnallocated', 'maxDeployed', 'maxDerivative', 'maxIlliquid'] as const) amount(`portfolio.${f}`, x.portfolio[f]);
  set('portfolio.deployAll', x.portfolio.deployAll);
  set('portfolio.autoReallocate', x.portfolio.autoReallocate);
  count('portfolio.validityMinutes', x.portfolio.validityMinutes, 10_000_000);

  const seen = new Set<Role>();
  for (const a of x.agents) {
    if (seen.has(a.role)) {
      issues.push({ kind: 'AMBIGUOUS', field: `agents.${a.role}`, text: `The ${a.role} agent was described twice; only the first reading was used.` });
      continue;
    }
    seen.add(a.role);
    set(`agents.${a.role}.enabled`, a.enabled);
    amount(`agents.${a.role}.maxAllocation`, a.maxAllocation);
    amount(`agents.${a.role}.maxExposure`, a.maxExposure);
    amount(`agents.${a.role}.budget`, a.budget);
  }

  for (const s of MARKET_SETS) {
    const ids = x.market[s];
    if (ids === null) continue;
    const known = catalogIds(s);
    const unknown = ids.filter((id) => !known.includes(id));
    for (const id of unknown) issues.push({ kind: 'UNSUPPORTED', field: `market.${s}`, text: `"${id.slice(0, 40)}" is not in the reviewed catalog and cannot be authorized.` });
    set(`market.${s}`, [...new Set(ids.filter((id) => known.includes(id)))]);
  }
  const leverage = x.market.maxLeverage;
  if (leverage !== null) {
    if (/^\d{1,2}(\.\d)?$/.test(leverage.trim())) set('market.maxLeverage', leverage.trim());
    else issues.push({ kind: 'AMBIGUOUS', field: 'market.maxLeverage', text: `Could not read "${leverage.slice(0, 8)}" as a leverage multiple; left unset.` });
  }
  count('market.maxSlippageBps', x.market.maxSlippageBps, 10_000);
  count('market.maxQuoteAgeSeconds', x.market.maxQuoteAgeSeconds, 86_400);
  if (x.market.syntheticExposure === 'ALLOWED') {
    issues.push({ kind: 'UNSUPPORTED', field: 'market.syntheticExposure', text: 'Synthetic exposure is forbidden by the reviewed catalog; a live mandate cannot allow it.' });
  }
  if (x.execution.recipients !== null) {
    const known = catalogIds('recipients');
    for (const id of x.execution.recipients.filter((r) => !known.includes(r))) issues.push({ kind: 'UNSUPPORTED', field: 'execution.recipients', text: `"${id.slice(0, 40)}" is not a reviewed recipient.` });
    set('execution.recipients', [...new Set(x.execution.recipients.filter((r) => known.includes(r)))]);
  }
  for (const i of x.issues) issues.push({ kind: i.kind, field: i.field !== null && fieldAt(d, i.field) !== undefined ? i.field : null, text: i.text });
  return { ...d, issues, notes: [...x.notes] };
}

// --- The deterministic local interpreter ----------------------------------------------------------

const MONEY = MONEY_PATTERN;

function money(m: RegExpExecArray, offset = 1): string | null {
  return moneyTextFromMatch(m, offset);
}

const ROLE_WORDS: { readonly [R in Role]: RegExp } = {
  stock: /\b(stocks?|equit(?:y|ies)|shares)\b/,
  swap: /\b(swaps?|token swaps?|spot swaps?|dex)\b/,
  nft: /\b(nfts?|collectibles?)\b/,
  yield: /\b(yield|earn|vaults?|savings|yield strategies)\b/,
  perps: /\b(perps?|perpetuals?|futures)\b/,
};

const NEGATED = (word: string) => new RegExp(String.raw`\b(?:no|without|exclude|excluding|avoid|skip|not|never|don'?t|do not)\s+(?:use\s+|any\s+|the\s+)?(?:${word})`);

const UNSUPPORTED = /\b(tesla|tsla|apple|aapl|microsoft|msft|amazon|amzn|solana|dogecoin|doge|memecoins?|meme coins?|gold|bonds?|options|prediction markets?)\b/g;
const VAGUE = /\b(safe|safest|blue[- ]chips?|reputable|high[- ]quality|trustworthy|trade a little|use some|use best agents|be safe)\b/g;
const RAW_ADDRESS = /\b0x[a-f0-9]{40}\b/i;
const ADVERSARIAL_EXEC = /\b(?:send (?:funds|profits|output|money)|calldata|ignore (?:previous|all) (?:limits?|instructions?)|enable everything|use any venue|whatever leverage)\b/i;

/**
 * A deterministic reading of common phrasings. It is deliberately fail-closed:
 * anything it does not recognise stays unset for the principal to fill.
 * Offline and in tests it stands in for a model; its output goes through
 * exactly the same `draftFromInterpretation`.
 */
export function interpretLocally(prompt: string): DraftInterpretation {
  const p = prompt.toLowerCase().replace(/\s+/g, ' ');
  const issues: DraftIssue[] = [];
  const notes: string[] = [];
  const portfolio: { [k: string]: string | boolean | null } = { totalCapital: null, minUnallocated: null, maxDeployed: null, deployAll: null, maxDerivative: null, maxIlliquid: null, validityMinutes: null, autoReallocate: null };
  const agents = new Map<Role, { enabled: boolean | null; maxAllocation: string | null; maxExposure: string | null; budget: string | null }>();
  const agent = (r: Role) => {
    const a = agents.get(r) ?? { enabled: null, maxAllocation: null, maxExposure: null, budget: null };
    agents.set(r, a);
    return a;
  };
  const market: { [k: string]: readonly string[] | string | null } = { assets: null, issuers: null, representations: null, venues: null, chains: null, maxLeverage: null, maxSlippageBps: null, maxQuoteAgeSeconds: null, syntheticExposure: null };

  const deployAll = /\b(?:deploy|invest|allocate|use|put)\s+(?:everything|it all|all of it|all\b|the whole|100 ?%)/.test(p) && !/\buse\s+at\s+most\b/.test(p);
  if (deployAll) {
    portfolio['deployAll'] = true;
    notes.push('"Deploy everything" read as: the maximum deployed equals total capital.');
  }

  // Ownership / budget statements: "I have $5k", "my total budget is $800", "five hundred dollars".
  const have =
    new RegExp(String.raw`\b(?:i have|i'?ve got|my (?:total )?(?:budget|capital|portfolio)(?: is| of|:)?|total (?:capital|budget|portfolio)(?: of| is|:)?)\s*(?:${MONEY})`).exec(p) ??
    /\b(five hundred)\s*(?:dollars?|usd[c]?)?\b/.exec(p);
  const total = new RegExp(String.raw`\btotal (?:capital|budget|portfolio)(?: of| is|:)?\s*(?:${MONEY})`).exec(p);
  // Bare "use $X" after an agent name is that agent's budget, not portfolio maxDeployed.
  const upTo =
    new RegExp(String.raw`\b(?:deploy|invest|allocate|put|manage)\s+(?:up to|at most|no more than|a maximum of|max(?:imum)?)?\s*(?:${MONEY})`).exec(p) ??
    new RegExp(String.raw`(?:^|[.!?]\s)use\s+(?:${MONEY})`).exec(p) ??
    new RegExp(String.raw`(?:${MONEY})\s+(?:across|between|among|split (?:across|between))\b`).exec(p) ??
    new RegExp(String.raw`^\s*(?:${MONEY})\s*(?:[.:;,]|$)`).exec(p) ??
    new RegExp(String.raw`\bwith\s+(?:${MONEY})\b`).exec(p);
  if (have !== null) {
    const amt = have[1] === 'five hundred' ? '500' : money(have);
    portfolio['totalCapital'] = amt;
  }
  if (total !== null) portfolio['totalCapital'] = money(total);
  if (upTo !== null) {
    portfolio['maxDeployed'] = money(upTo);
    if (portfolio['totalCapital'] === null) {
      portfolio['totalCapital'] = portfolio['maxDeployed'] ?? null;
      notes.push('The amount to deploy was also read as total capital, since no other total was given.');
    }
  }
  // "use at most $1,500 of my $2,000"
  const atMostOf = new RegExp(String.raw`\b(?:use|deploy|invest)\s+at most\s+(?:${MONEY})\s+of\s+(?:my\s+)?(?:${MONEY})`).exec(p);
  if (atMostOf !== null) {
    portfolio['maxDeployed'] = money(atMostOf, 1);
    portfolio['totalCapital'] = money(atMostOf, 5);
    portfolio['deployAll'] = false;
  }

  const keepMoney = new RegExp(String.raw`\b(?:keep|leave|hold|reserve|set aside)\s+(?:at least\s+|a minimum of\s+|min(?:imum)?\s+)?(?:${MONEY})\s*(?:unallocated|free|in reserve|uninvested|undeployed|aside|in cash|as cash|as a buffer|untouched|in the wallet)`).exec(p);
  const keepHalf = /\b(?:keep|leave|hold|reserve)\s+(?:at least\s+)?(?:half|50\s*%)\s*(?:unallocated|free|untouched|aside|undeployed)?/.exec(p);
  if (keepMoney !== null) portfolio['minUnallocated'] = money(keepMoney);
  else if (keepHalf !== null) {
    const base = portfolio['totalCapital'] === null ? null : parseUsdc(portfolio['totalCapital'] as string);
    const half = resolveShare({ kind: 'HALF' }, base);
    if (half === null) issues.push({ kind: 'AMBIGUOUS', field: 'portfolio.minUnallocated', text: 'Half untouched needs a known total portfolio capital.' });
    else {
      portfolio['minUnallocated'] = atomsText(half);
      notes.push('"Keep half untouched" derived from total capital.');
    }
  }
  if (/\b(?:keep the rest available|leave unused cash alone|don'?t deploy everything)\b/.test(p)) {
    notes.push('Unused capital may remain unused; nothing forces full deployment.');
    if (portfolio['deployAll'] === true) {
      portfolio['deployAll'] = false;
      issues.push({ kind: 'CONFLICT', field: 'portfolio.deployAll', text: '"Deploy everything" conflicts with leaving unused capital alone. Choose one.' });
    }
  }
  if (deployAll && keepMoney !== null) {
    issues.push({ kind: 'CONFLICT', field: 'portfolio.minUnallocated', text: `"Deploy everything" conflicts with keeping ${money(keepMoney) ?? 'an amount'} USDC unallocated. Choose one.` });
  }

  // Cap language must stay near the role — do not span across another agent name.
  const nearCap = String.raw`(?:\s+(?:can use|exposure|capital|budget|allocation|agent))?\s+(?:max(?:imum)?|at most|up to|capped at|cap(?: of)?|limit(?:ed)? to|limit of|no more than|under|below|never above)\s*(?:${MONEY})`;
  const derivative = new RegExp(String.raw`\b(?:perps?|perpetuals?|derivatives?|futures)\b${nearCap}`).exec(p);
  if (derivative !== null) portfolio['maxDerivative'] = money(derivative, 1);
  const illiquid = new RegExp(String.raw`\b(?:nfts?|illiquid|collectibles?)\b${nearCap}`).exec(p);
  if (illiquid !== null) portfolio['maxIlliquid'] = money(illiquid, 1);
  for (const [role, word] of [['stock', String.raw`stocks?|equit(?:y|ies)`], ['swap', String.raw`swaps?`], ['yield', String.raw`yield|vaults?|earn`], ['nft', String.raw`nfts?`], ['perps', String.raw`perps?|perpetuals?`]] as const) {
    const m = new RegExp(String.raw`\b(?:${word})\b${nearCap}`).exec(p);
    if (m !== null) {
      const amount = money(m, 1);
      if (amount === null) continue;
      agent(role).maxAllocation = amount;
      if (role === 'perps' && portfolio['maxDerivative'] === null) portfolio['maxDerivative'] = amount;
      if (role === 'nft' && portfolio['maxIlliquid'] === null) portfolio['maxIlliquid'] = amount;
    }
  }
  // "Stock and Perps can use $2k" — shared ceiling/total for the named group.
  const groupUse = new RegExp(String.raw`\b((?:stocks?|swaps?|nfts?|yield|perps?|equities)(?:\s*,\s*|\s+and\s+)(?:stocks?|swaps?|nfts?|yield|perps?|equities)(?:(?:\s*,\s*|\s+and\s+)(?:stocks?|swaps?|nfts?|yield|perps?|equities))*)\s+can use\s+(?:${MONEY})`).exec(p);
  if (groupUse !== null) {
    const amount = money(groupUse, 2);
    if (amount !== null && portfolio['totalCapital'] === null) {
      portfolio['totalCapital'] = amount;
      portfolio['maxDeployed'] = amount;
      notes.push(`"${groupUse[0].trim()}" read as the portfolio total those agents may draw from.`);
    }
  }

  // Share language against a named agent: "Give Stock half"
  for (const r of ROLES) {
    const word = ROLE_WORDS[r].source.replace(/\\b/g, '');
    const shareHit = new RegExp(String.raw`\b(?:give|let|allow|have)\s+(?:the\s+)?(?:${word})(?:\s+agent)?\s+(?:half|50\s*%|\d{1,2}(?:\.\d{1,2})?\s*%)`).exec(p);
    if (shareHit !== null) {
      const share = parseShareLanguage(shareHit[0]);
      const base = portfolio['totalCapital'] === null ? null : parseUsdc(portfolio['totalCapital'] as string);
      const resolved = share === null ? null : resolveShare(share, base);
      if (resolved === null) issues.push({ kind: 'AMBIGUOUS', field: `agents.${r}.budget`, text: `A share for ${r} needs a known total portfolio capital.` });
      else {
        const text = atomsText(resolved);
        agent(r).enabled = true;
        agent(r).budget = text;
        agent(r).maxAllocation = text;
        notes.push(`"${shareHit[0].trim()}" derived ${r} budget ${text} USDC from total capital.`);
      }
    }
  }

  const roleWord = (r: Role): string => ROLE_WORDS[r].source.replace(/\\b/g, '').replace(/^\((?!\?)/, '(?:');

  // A role named directly with an amount is that agent's budget: "Stock $800", "swap: $400", "perps gets $300".
  // Skip "can use $N" when it is the shared group phrase ("Stock and Perps can use $2k").
  const sharedUse = groupUse?.[0] ?? '';
  for (const r of ROLES) {
    const m = new RegExp(String.raw`\b${roleWord(r)}\s*(?::|=|-|–|gets|can use|budget(?: of)?|with)?\s*(?:${MONEY})`).exec(p);
    if (m !== null) {
      if (sharedUse !== '' && sharedUse.includes(m[0].trim())) {
        agent(r).enabled = true;
        continue;
      }
      const amount = money(m, 1);
      if (amount !== null) {
        agent(r).budget = amount;
        agent(r).enabled = true;
        notes.push(`"${m[0].trim()}" read as the ${r} agent's budget: the most it may use, not an amount it must spend.`);
      }
    }
  }
  // "Give Stock $800 and Yield $400"
  for (const r of ROLES) {
    const give = new RegExp(String.raw`\bgive\s+(?:the\s+)?(?:${roleWord(r)})(?:\s+agent)?\s+(?:${MONEY})`).exec(p);
    if (give !== null) {
      const amount = money(give, 1);
      if (amount === null) continue;
      agent(r).enabled = true;
      agent(r).budget = amount;
      agent(r).maxAllocation = amount;
      notes.push(`"${give[0].trim()}" read as the ${r} agent's fixed budget.`);
    }
  }
  // "… the remaining $800" with fixed budgets → total = fixed + remainder when no total was stated.
  const remaining = new RegExp(String.raw`\b(?:the\s+)?(?:remaining|rest|remainder)\s+(?:${MONEY})`).exec(p);
  if (remaining !== null && portfolio['totalCapital'] === null) {
    const rem = money(remaining, 1);
    let fixed = 0n;
    for (const a of agents.values()) {
      if (a.budget !== null) {
        const b = parseUsdc(a.budget);
        if (b !== null) fixed += b;
      }
    }
    if (rem !== null) {
      const remAtoms = parseUsdc(rem);
      if (remAtoms !== null) {
        portfolio['totalCapital'] = usdcText(fixed + remAtoms);
        portfolio['maxDeployed'] = portfolio['totalCapital'];
        notes.push(`Remaining ${rem} USDC plus fixed budgets implies total capital ${portfolio['totalCapital']} USDC.`);
      }
    }
  }
  if (/\b(?:let|allow)\b[^.;\n]*\b(?:decide|split|allocate|choose)\b[^.;\n]*\b(?:rest|remainder|remaining|the others?|how to (?:use|split)|however they)\b/.test(p) || /\bdecide how to (?:use|split)\b/.test(p) || /\bhowever they think is best\b/.test(p)) {
    notes.push('The amount not fixed above is left to the remaining agents to split: they propose, you review before signing.');
  }
  if (/\b(?:no|without|never|don'?t|do not)\s+(?:automatic(?:ally)?\s+)?(?:re-?allocat|rebalanc)\w*|\bkeep each agent'?s budget separate\b|\bdon'?t move unused capital\b|\bno automatic reallocation\b/.test(p)) {
    portfolio['autoReallocate'] = false;
  } else if (/\b(?:automatic(?:ally)?\s+(?:re-?allocat|rebalanc)\w*|(?:re-?allocate|rebalance)\w*\s+automatically|auto[- ]?(?:re-?allocat|rebalanc)\w*|let (?:them|the agents|agents|mandate) (?:re-?allocate|rebalance|move (?:unused )?capital)|reallocate unused capital automatically|agents can move unused capital)\b/.test(p)) {
    portfolio['autoReallocate'] = true;
    notes.push('Automatic reallocation read as allowed: capital an agent leaves unused may move to other agents, inside each signed maximum.');
  }

  // Risk preference is advisory only — never grants leverage, perps, or venues.
  if (/\b(?:conservative(?:ly)?|low[- ]risk)\b/.test(p)) notes.push('Risk preference (advisory only): CONSERVATIVE — does not grant leverage, Perps, or widen venues.');
  else if (/\b(?:moderate(?:ly)?|balanced)\b/.test(p) && !/\bbalanced preset\b/.test(p)) notes.push('Risk preference (advisory only): MODERATE — does not grant leverage, Perps, or widen venues.');
  else if (/\b(?:aggressive(?:ly)?|high[- ]risk)\b/.test(p)) notes.push('Risk preference (advisory only): AGGRESSIVE — does not grant leverage, Perps, or widen venues.');

  // "Let the Stock agent manage $800": that agent's ceiling, which is the field the compose form shows.
  const directedRoles: Role[] = [];
  for (const r of ROLES) {
    const word = ROLE_WORDS[r].source.replace(/\\b/g, '').replace(/^\(/, '').replace(/\)$/, '');
    const directed = new RegExp(String.raw`\b(?:let|allow|have)\s+(?:the\s+)?(?:${word})\s+agent\s+(?:manage|deploy|invest|use|allocate)\s+(?:${MONEY})`).exec(p);
    if (directed !== null) {
      const amount = money(directed);
      agent(r).enabled = true;
      agent(r).maxAllocation = amount;
      agent(r).budget = amount;
      directedRoles.push(r);
      if (portfolio['totalCapital'] === null) {
        portfolio['totalCapital'] = amount;
        portfolio['maxDeployed'] = amount;
      }
      notes.push(`"${directed[0].trim()}" read as the ${r} agent's maximum allocation.`);
    }
  }
  if (directedRoles.length === 1) {
    for (const r of ROLES) if (!directedRoles.includes(r)) agent(r).enabled = false;
  }

  // "every agent" / "all five agents" / "let every agent use"
  const everyAgent = /\b(?:every|all)\s+(?:five\s+)?agents?\b|\ball five\b/.test(p);
  if (everyAgent) {
    for (const r of ROLES) agent(r).enabled = true;
    notes.push('Every agent explicitly enabled because the prompt named every agent.');
    const everyAmt = new RegExp(String.raw`\blet every agent use\s+(?:${MONEY})|\b(?:every|all)\s+(?:five\s+)?agents?\s+use\s+(?:${MONEY})`).exec(p);
    if (everyAmt !== null && portfolio['totalCapital'] === null) {
      const amount = money(everyAmt, 1);
      portfolio['totalCapital'] = amount;
      portfolio['maxDeployed'] = amount;
    }
  }

  const mentioned = ROLES.filter((r) => ROLE_WORDS[r].test(p));
  const negated = ROLES.filter((r) => NEGATED(ROLE_WORDS[r].source.replace(/\\b/g, '')).test(p));
  // "never use leverage" is not "no perps" by itself — leverage handled below.
  for (const r of negated) agent(r).enabled = false;
  const positive = mentioned.filter((r) => !negated.includes(r));
  for (const r of positive) agent(r).enabled = true;
  if (!everyAgent && positive.length >= 2) {
    const off = ROLES.filter((r) => !mentioned.includes(r) && !negated.includes(r));
    for (const r of off) {
      if (agent(r).enabled === null) agent(r).enabled = false;
    }
    if (off.length > 0) notes.push(`Not named in the list of strategies, so disabled (no authority): ${off.join(', ')}.`);
  }
  // Explicit negation wins if both said.
  for (const r of negated) agent(r).enabled = false;

  // Capital with no agents → clarification; leave enabled null.
  if (portfolio['totalCapital'] !== null && positive.length === 0 && directedRoles.length === 0 && !everyAgent && negated.length === 0) {
    issues.push({ kind: 'NEEDS_CLARIFICATION', field: null, text: `Which agents may use the $${portfolio['totalCapital']}? Mandate does not enable agents that were not named.` });
  }

  if (/\b(?:no|without|avoid|forbid|never)\s+(?:any\s+)?synthetic/.test(p)) {
    market['syntheticExposure'] = 'FORBIDDEN';
    notes.push('Synthetic exposure forbidden (the reviewed catalog already forbids it).');
  } else if (/\b(?:allow|permit|include)\s+synthetic|synthetic\s+(?:is|are)\s+(?:ok|fine|allowed)/.test(p)) market['syntheticExposure'] = 'ALLOWED';
  const approved = /\b(?:only\s+)?approved\s+([a-z ,&]+?)(?:[.;\n]|$)/.exec(p);
  if (approved !== null) {
    const list = approved[1] ?? '';
    for (const [set, word] of [['issuers', 'issuers?'], ['venues', 'venues?|routes?'], ['assets', 'assets?'], ['chains', 'chains?'], ['representations', 'representations?|tokens?']] as const) {
      if (new RegExp(String.raw`\b(?:${word})\b`).test(list)) {
        market[set] = catalogIds(set);
        notes.push(`"Approved ${set}" read as every reviewed ${set.replace(/s$/, '')} in the catalog.`);
      }
    }
  }
  if (/\b(?:approved (?:venues?|routes?) only|only (?:use )?approved (?:venues?|routes?|robinhood))\b/.test(p)) {
    market['venues'] = catalogIds('venues');
    notes.push('"Approved venues only" read as every reviewed venue in the catalog.');
  }

  // Catalog asset allow: "only NVDA" maps when the ticker is in the reviewed catalog labels/ids.
  const onlyAssets = /\bonly\s+([a-z0-9 ,&/+-]+?)(?:[.;\n]|$)/.exec(p);
  if (onlyAssets !== null && !/approved/.test(onlyAssets[1] ?? '')) {
    const tokens = (onlyAssets[1] ?? '').split(/[,&\s]+/).map((t) => t.trim()).filter((t) => t.length > 0);
    const ids: string[] = [];
    for (const t of tokens) {
      const hit = CATALOG.assets.find((e) => e.id === t || e.label.toLowerCase().includes(t));
      if (hit !== undefined) ids.push(hit.id);
      else if (!/and|or|the/.test(t)) issues.push({ kind: 'UNSUPPORTED', field: 'market.assets', text: `"${t}" is not in the reviewed catalog and cannot be authorized.` });
    }
    if (ids.length > 0) market['assets'] = [...new Set(ids)];
  }
  const blockAsset = /\b(?:don'?t|do not|never)\s+buy\s+([a-z0-9-]+)/.exec(p);
  if (blockAsset !== null) {
    issues.push({ kind: 'NEEDS_CLARIFICATION', field: 'market.assets', text: `Blocking "${blockAsset[1]}" requires choosing the allowed asset set explicitly; Mandate does not invent the complement.` });
  }

  const noLev = /\b(?:no leverage|unleveraged|without leverage|1x only|never use leverage|don'?t go above 1\s*x)\b/.test(p);
  const lev = /(?:max(?:imum)?|at most|up to|no more than|don'?t go above|never above)\s*(\d{1,2}(?:\.\d)?)\s*x(?:\s*leverage)?|leverage\s*(?:of\s*)?(?:max(?:imum)?|at most|up to|below|under|<=|≤)?\s*(\d{1,2}(?:\.\d)?)\s*x/.exec(p);
  if (noLev && lev !== null) {
    issues.push({ kind: 'CONFLICT', field: 'market.maxLeverage', text: 'The prompt both forbids leverage and sets a maximum leverage. Choose one.' });
  } else if (noLev) market['maxLeverage'] = '1';
  else if (lev !== null) {
    const v = lev[1] ?? lev[2] ?? null;
    if (v === '0') issues.push({ kind: 'AMBIGUOUS', field: 'market.maxLeverage', text: '0x leverage is not a valid multiple; left unset.' });
    else market['maxLeverage'] = v;
  }
  if (/\bwhatever leverage\b/.test(p)) {
    issues.push({ kind: 'UNSUPPORTED', field: 'market.maxLeverage', text: 'Unbounded leverage is not granted from language; name an explicit maximum such as "max 2x".' });
  }

  const slip = /slippage[^.;\n]*?(\d+(?:\.\d+)?)\s*(bps|basis points|%)|(?:max(?:imum)?|under|below)\s*(\d+(?:\.\d+)?)\s*(bps|basis points|%)\s*slippage/.exec(p);
  if (slip !== null) {
    const n = slip[1] ?? slip[3] ?? '';
    const unit = slip[2] ?? slip[4] ?? '';
    const bps = unit === '%' ? (/^\d+(\.\d{1,2})?$/.test(n) ? String(Math.round(Number(n) * 100)) : null) : /^\d+$/.test(n) ? n : null;
    if (bps === null) issues.push({ kind: 'AMBIGUOUS', field: 'market.maxSlippageBps', text: `Could not read slippage "${n}${unit}" exactly.` });
    else if (Number(bps) < 0 || Number(bps) > 10_000) issues.push({ kind: 'AMBIGUOUS', field: 'market.maxSlippageBps', text: `Slippage ${bps} bps is out of range; left unset.` });
    else market['maxSlippageBps'] = bps;
  }
  const fee = /\b(?:fee|fees)\b[^.;\n]*?(\d+(?:\.\d+)?)\s*(bps|basis points|%)|(?:don'?t pay more than|fee cap)\s*(\d+(?:\.\d+)?)\s*(bps|basis points|%)/.exec(p);
  if (fee !== null) {
    issues.push({ kind: 'UNSUPPORTED', field: null, text: 'A fee-bps cap is not a signed Live Lab mandate field; name agent ceilings and slippage instead.' });
  }
  const perTrade = new RegExp(String.raw`\b(?:never spend more than|no trade above|don'?t move more than)\s*(?:${MONEY})\s*(?:per trade|each trade|in one trade)?|\b(?:max(?:imum)?)\s*(?:${MONEY})\s*(?:per trade|each trade|in one trade)`).exec(p);
  if (perTrade !== null) {
    issues.push({ kind: 'UNSUPPORTED', field: null, text: `A per-trade cap (${money(perTrade, 1) ?? 'amount'} USDC) is not a signed Live Lab mandate field; set each agent's budget or ceiling instead.` });
  }
  const perTradePct = /\bno trade above\s*(\d{1,2}(?:\.\d{1,2})?)\s*%\b/.exec(p);
  if (perTradePct !== null) {
    const base = portfolio['totalCapital'] === null ? null : parseUsdc(portfolio['totalCapital'] as string);
    if (base === null) issues.push({ kind: 'AMBIGUOUS', field: null, text: 'A percentage per-trade cap needs a known total portfolio capital.' });
    else issues.push({ kind: 'UNSUPPORTED', field: null, text: 'A per-trade percentage cap is not a signed Live Lab mandate field; set each agent\'s budget instead.' });
  }

  const quote = /quotes?[^.;\n]*?(?:older than|fresher than|within|max(?:imum)? age(?: of)?|at most|under|must be under)\s*(\d+)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/.exec(p);
  if (quote !== null) market['maxQuoteAgeSeconds'] = String(Number(quote[1]) * (/^m/.test(quote[2] ?? '') ? 60 : 1));
  const validity = /\b(?:for|valid for|expires? in|over the next|lasting|expire in)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b|\bvalid for today\b/.exec(p);
  if (validity !== null) {
    if (validity[0]?.includes('today')) portfolio['validityMinutes'] = '1440';
    else {
      const n = Number(validity[1]);
      const unit = validity[2] ?? '';
      portfolio['validityMinutes'] = String(/^d/.test(unit) ? n * 1440 : /^h/.test(unit) ? n * 60 : n);
    }
  }

  if (/\b(?:buy only|don'?t sell|do not sell|no new purchases|only reduce)\b/.test(p)) {
    if (/\bonly reduce\b/.test(p)) issues.push({ kind: 'UNSUPPORTED', field: null, text: 'Reduce-only / sell actions are not in the Live Lab action set; agents are buy/open/deposit only.' });
    else notes.push('Live Lab actions are already buy/open/deposit only; no sell authority exists to grant.');
  }

  if (/\bcalldata\b/i.test(prompt) || /\b0x[a-f0-9]{8,}\b/i.test(prompt) && !RAW_ADDRESS.test(prompt)) {
    issues.push({ kind: 'UNSUPPORTED', field: null, text: 'Calldata or raw hex execution payloads cannot be authorized from a prompt.' });
  }
  if (RAW_ADDRESS.test(prompt) || /\bsend (?:funds|profits|output|money)\s+to\b/i.test(prompt)) {
    issues.push({ kind: 'UNSUPPORTED', field: 'execution.recipients', text: 'Arbitrary recipient addresses or "send to" instructions are refused; only reviewed catalog recipients may be authorized.' });
  }
  if (/\bhalf\b/.test(p) && portfolio['totalCapital'] === null && !agents.size) {
    issues.push({ kind: 'AMBIGUOUS', field: 'portfolio.totalCapital', text: 'Half of what total portfolio capital?' });
  }
  // Trailing "Total $X" / "Capital is $X" (optionally followed by filler like "at the end")
  const trailingTotal = new RegExp(String.raw`\b(?:total|capital)\s*(?:is|:)?\s*(?:${MONEY})`).exec(p);
  if (trailingTotal !== null) {
    const amount = money(trailingTotal, 1);
    if (amount !== null) {
      portfolio['totalCapital'] = amount;
      if (portfolio['maxDeployed'] === null) portfolio['maxDeployed'] = amount;
    }
  }
  // "Stock only" / "NFT only"
  const onlyRole = /\b(stocks?|swaps?|nfts?|yield|perps?|equities)\s+only\b/.exec(p);
  if (onlyRole !== null) {
    const token = onlyRole[1] ?? '';
    const map: { readonly [k: string]: Role } = { stock: 'stock', stocks: 'stock', equities: 'stock', swap: 'swap', swaps: 'swap', nft: 'nft', nfts: 'nft', yield: 'yield', perp: 'perps', perps: 'perps' };
    const role = map[token];
    if (role !== undefined) {
      for (const r of ROLES) agent(r).enabled = r === role;
    }
  }
  // "Enable Stock" / "Disable NFT"
  for (const r of ROLES) {
    const w = roleWord(r);
    if (new RegExp(String.raw`\benable\s+(?:the\s+)?(?:${w})\b`).test(p)) agent(r).enabled = true;
    if (new RegExp(String.raw`\bdisable\s+(?:the\s+)?(?:${w})\b`).test(p)) agent(r).enabled = false;
  }
  // "anything except perps"
  const except = /\b(?:anything|everything)\s+except\s+([a-z ,]+)/.exec(p);
  if (except !== null) {
    for (const r of ROLES) {
      if (ROLE_WORDS[r].test(except[1] ?? '')) agent(r).enabled = false;
      else if (agent(r).enabled === null && ROLE_WORDS[r].test(p)) agent(r).enabled = true;
    }
  }
  if (ADVERSARIAL_EXEC.test(p) && !/\bwhatever leverage\b/.test(p)) {
    if (/\benable everything\b/.test(p) && !everyAgent) {
      issues.push({ kind: 'NEEDS_CLARIFICATION', field: null, text: '"Enable everything" does not name agents or venues. Which agents may act, inside which reviewed catalog?' });
    }
    if (/\buse any venue\b/.test(p)) {
      issues.push({ kind: 'UNSUPPORTED', field: 'market.venues', text: '"Any venue" is refused; only reviewed catalog venues may be authorized.' });
    }
    if (/\bignore (?:previous|all)/.test(p)) {
      issues.push({ kind: 'UNSUPPORTED', field: null, text: 'Instructions to ignore limits are refused; the signed mandate is the only authority.' });
    }
  }

  for (const m of p.matchAll(VAGUE)) {
    issues.push({ kind: 'NEEDS_CLARIFICATION', field: null, text: `"${m[1]}" is not a Mandate term. Name the assets, issuers and limits you mean; nothing was decided for you.` });
  }
  for (const m of p.matchAll(UNSUPPORTED)) {
    issues.push({ kind: 'UNSUPPORTED', field: null, text: `"${m[1]}" is not in the reviewed catalog and cannot be authorized in this lab.` });
  }
  const unique = (xs: readonly DraftIssue[]) => [...new Map(xs.map((i) => [`${i.kind}|${i.text}`, i])).values()];

  return {
    portfolio: portfolio as unknown as DraftInterpretation['portfolio'],
    agents: [...agents.entries()].map(([role, a]) => ({ role, ...a })),
    market: market as unknown as DraftInterpretation['market'],
    execution: { recipients: null },
    issues: unique(issues).slice(0, MAX_ISSUES),
    notes: notes.slice(0, MAX_NOTES),
  };
}

/** The local interpreter's answer as model text: the same JSON a model returns. */
export function interpretLocallyAsText(prompt: string): string {
  return JSON.stringify(interpretLocally(prompt));
}

export interface Interpreted {
  readonly outcome: CallOutcome<DraftInterpretation>;
  /** Present when the interpreter answered in the schema. Still only a draft. */
  readonly draft: MandateDraft | null;
}

/**
 * The prompt's own explicit amounts and agent choices win over a model draft.
 * A model may fill what the prompt did not say. It may not replace "$800"
 * with a preset-shaped total. Null local fields are left to the model.
 */
export function preferExplicitPrompt(model: DraftInterpretation, prompt: string): DraftInterpretation {
  const local = interpretLocally(prompt);
  const portfolio: { [K in keyof DraftInterpretation['portfolio']]: DraftInterpretation['portfolio'][K] } = { ...model.portfolio };
  const write = portfolio as { [key: string]: string | boolean | null };
  for (const key of PORTFOLIO_FIELDS) {
    const value = local.portfolio[key];
    if (value !== null) write[key] = value;
  }
  const byRole = new Map(model.agents.map((item) => [item.role, { ...item }] as const));
  for (const item of local.agents) {
    const current = byRole.get(item.role) ?? { role: item.role, enabled: null, maxAllocation: null, maxExposure: null, budget: null };
    byRole.set(item.role, {
      role: item.role,
      enabled: item.enabled ?? current.enabled,
      maxAllocation: item.maxAllocation ?? current.maxAllocation,
      maxExposure: item.maxExposure ?? current.maxExposure,
      budget: item.budget ?? current.budget,
    });
  }
  return { ...model, portfolio, agents: ROLES.map((role) => byRole.get(role)).filter((item) => item !== undefined), notes: [...local.notes, ...model.notes].slice(0, MAX_NOTES) };
}

/** Ask a provider to interpret `prompt`. A failed or malformed answer yields no draft; nothing falls back silently. */
export async function interpretPrompt(prompt: string, provider: AgentModelProvider, clock: Clock, timeoutMs: number): Promise<Interpreted> {
  const outcome = await callModel({ provider, request: draftRequest(prompt.slice(0, 2_000)), parse: parseDraftInterpretation, timeoutMs, clock });
  if (outcome.status !== 'RESPONDED') return { outcome, draft: null };
  // Local explicit language wins over the model; model-only fills keep MODEL_EXTRACTED.
  const local = interpretLocally(prompt);
  const merged = preferExplicitPrompt(outcome.value, prompt);
  let draft = draftFromInterpretation(merged, 'MODEL_EXTRACTED');
  const localDraft = draftFromInterpretation(local, 'EXPLICIT_PROMPT');
  for (const path of Object.keys(localDraft.provenance)) {
    const v = fieldAt(localDraft, path);
    if (v !== null && v !== undefined) draft = withField(draft, path, v, 'EXPLICIT_PROMPT', localDraft.evidence[path]?.sourceText);
  }
  const issues = [...localDraft.issues, ...draft.issues];
  const notes = [...localDraft.notes, ...draft.notes].filter((n, i, a) => a.indexOf(n) === i).slice(0, MAX_NOTES);
  const seen = new Map(issues.map((i) => [`${i.kind}|${i.text}`, i] as const));
  return { outcome, draft: { ...draft, issues: [...seen.values()].slice(0, MAX_ISSUES), notes, evidence: { ...draft.evidence, ...localDraft.evidence } } };
}

export type { IssueKind };
