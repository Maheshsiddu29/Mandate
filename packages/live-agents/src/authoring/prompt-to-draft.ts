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
import { emptyDraft, fieldAt, ISSUE_KINDS, withField, type DraftIssue, type IssueKind, type MandateDraft } from './draft-types.ts';
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
 */
export function draftFromInterpretation(x: DraftInterpretation): MandateDraft {
  let d = emptyDraft();
  const issues: DraftIssue[] = [];
  const set = (path: string, value: string | boolean | readonly string[] | null) => {
    if (value !== null) d = withField(d, path, value, 'INTERPRETED');
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

const MONEY = String.raw`\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b|thousand\b)?|(\d[\d,]*(?:\.\d+)?)\s*(k\b|thousand\b)?\s*(?:usd[c]?|dollars)`;

function money(m: RegExpExecArray, offset = 1): string | null {
  const digits = m[offset] ?? m[offset + 2];
  const k = m[offset + 1] ?? m[offset + 3];
  if (digits === undefined) return null;
  const atoms = parseUsdc(digits);
  if (atoms === null) return null;
  return usdcText(k === undefined ? atoms : atoms * 1000n);
}

const ROLE_WORDS: { readonly [R in Role]: RegExp } = {
  stock: /\b(stocks?|equit(?:y|ies)|shares)\b/,
  swap: /\b(swaps?|token swaps?|dex)\b/,
  nft: /\b(nfts?|collectibles?)\b/,
  yield: /\b(yield|vaults?|savings)\b/,
  perps: /\b(perps?|perpetuals?|futures|derivatives?)\b/,
};

const NEGATED = (word: string) => new RegExp(String.raw`\b(?:no|without|exclude|excluding|avoid|skip|not)\s+(?:any\s+)?(?:${word})`);

const UNSUPPORTED = /\b(tesla|tsla|apple|aapl|microsoft|msft|amazon|amzn|solana|dogecoin|doge|memecoins?|meme coins?|gold|bonds?|options)\b/g;
const VAGUE = /\b(safe|safest|low[- ]risk|blue[- ]chips?|reputable|high[- ]quality|trustworthy)\b/g;

/**
 * A deterministic reading of common phrasings. It is deliberately narrow:
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

  const deployAll = /\b(?:deploy|invest|allocate|use|put)\s+(?:everything|it all|all of it|all\b|the whole|100 ?%)/.test(p);
  if (deployAll) {
    portfolio['deployAll'] = true;
    notes.push('"Deploy everything" read as: the maximum deployed equals total capital.');
  }
  const total = new RegExp(String.raw`\btotal (?:capital|budget|portfolio)(?: of| is|:)?\s*(?:${MONEY})`).exec(p);
  // "Deploy $2,000", "Manage $2,000", "$2,000 across …", or a prompt that opens with the amount ("$2,000. Stock $800, …").
  const upTo =
    new RegExp(String.raw`\b(?:deploy|invest|allocate|put|use|manage)\s+(?:up to|at most|no more than|a maximum of|max(?:imum)?)?\s*(?:${MONEY})`).exec(p) ??
    new RegExp(String.raw`(?:${MONEY})\s+(?:across|between|among|split (?:across|between))\b`).exec(p) ??
    new RegExp(String.raw`^\s*(?:${MONEY})\s*(?:[.:;,]|$)`).exec(p);
  if (total !== null) portfolio['totalCapital'] = money(total);
  if (upTo !== null) {
    portfolio['maxDeployed'] = money(upTo);
    if (total === null) {
      portfolio['totalCapital'] = portfolio['maxDeployed'] ?? null;
      notes.push('The amount to deploy was also read as total capital, since no other total was given.');
    }
  }
  const keep = new RegExp(String.raw`\b(?:keep|leave|hold|reserve|set aside)\s+(?:at least\s+|a minimum of\s+|min(?:imum)?\s+)?(?:${MONEY})\s*(?:unallocated|free|in reserve|uninvested|undeployed|aside|in cash|as cash|as a buffer|untouched)`).exec(p);
  if (keep !== null) portfolio['minUnallocated'] = money(keep);
  if (deployAll && keep !== null) {
    issues.push({ kind: 'CONFLICT', field: 'portfolio.minUnallocated', text: `"Deploy everything" conflicts with keeping ${money(keep) ?? 'an amount'} USDC unallocated. Choose one.` });
  }

  const cap = String.raw`[^.;\n]*?\b(?:max(?:imum)?|at most|up to|capped at|cap(?: of)?|limit(?:ed)? to|limit of|no more than|under|below)\s*(?:${MONEY})`;
  const derivative = new RegExp(String.raw`\b(?:perps?|perpetuals?|derivatives?|futures)\b${cap}`).exec(p);
  if (derivative !== null) portfolio['maxDerivative'] = money(derivative);
  const illiquid = new RegExp(String.raw`\b(?:nfts?|illiquid|collectibles?)\b${cap}`).exec(p);
  if (illiquid !== null) portfolio['maxIlliquid'] = money(illiquid);
  for (const [role, word] of [['stock', String.raw`stocks?|equit(?:y|ies)`], ['swap', String.raw`swaps?`], ['yield', String.raw`yield|vaults?`]] as const) {
    const m = new RegExp(String.raw`\b(?:${word})\b${cap}`).exec(p);
    if (m !== null) agent(role).maxAllocation = money(m);
  }

  // A role named directly with an amount is that agent's budget: "Stock $800", "swap: $400", "perps gets $300".
  for (const r of ROLES) {
    const word = ROLE_WORDS[r].source.replace(/\\b/g, '');
    const m = new RegExp(String.raw`\b${word}\s*(?::|=|-|–|gets|budget(?: of)?|with)?\s*(?:${MONEY})`).exec(p);
    if (m !== null) {
      agent(r).budget = money(m, 2);
      notes.push(`"${m[0].trim()}" read as the ${r} agent's budget: the most it may use, not an amount it must spend.`);
    }
  }
  if (/\b(?:let|allow)\b[^.;\n]*\b(?:decide|split|allocate|choose)\b[^.;\n]*\b(?:rest|remainder|remaining|the others?)\b/.test(p)) notes.push('The amount not fixed above is left to the remaining agents to split: they propose, you review before signing.');
  if (/\b(?:no|without|never|don'?t|do not)\s+(?:automatic(?:ally)?\s+)?(?:re-?allocat|rebalanc)\w*/.test(p)) portfolio['autoReallocate'] = false;
  else if (/\b(?:automatic(?:ally)?\s+(?:re-?allocat|rebalanc)\w*|(?:re-?allocate|rebalance)\w*\s+automatically|auto[- ]?(?:re-?allocat|rebalanc)\w*|let (?:them|the agents|agents) (?:re-?allocate|rebalance|move capital))/.test(p)) {
    portfolio['autoReallocate'] = true;
    notes.push('Automatic reallocation read as allowed: capital an agent leaves unused may move to other agents, inside each signed maximum.');
  }

  const mentioned = ROLES.filter((r) => ROLE_WORDS[r].test(p));
  const negated = ROLES.filter((r) => NEGATED(ROLE_WORDS[r].source.replace(/\\b/g, '')).test(p));
  for (const r of negated) agent(r).enabled = false;
  const positive = mentioned.filter((r) => !negated.includes(r));
  for (const r of positive) agent(r).enabled = true;
  if (positive.length >= 2) {
    const off = ROLES.filter((r) => !mentioned.includes(r));
    for (const r of off) agent(r).enabled = false;
    if (off.length > 0) notes.push(`Not named in the list of strategies, so disabled (no authority): ${off.join(', ')}.`);
  }

  if (/\b(?:no|without|avoid|forbid|never)\s+(?:any\s+)?synthetic/.test(p)) {
    market['syntheticExposure'] = 'FORBIDDEN';
    notes.push('Synthetic exposure forbidden (the reviewed catalog already forbids it).');
  } else if (/\b(?:allow|permit|include)\s+synthetic|synthetic\s+(?:is|are)\s+(?:ok|fine|allowed)/.test(p)) market['syntheticExposure'] = 'ALLOWED';
  const approved = /\b(?:only\s+)?approved\s+([a-z ,&]+?)(?:[.;\n]|$)/.exec(p);
  if (approved !== null) {
    const list = approved[1] ?? '';
    for (const [set, word] of [['issuers', 'issuers?'], ['venues', 'venues?'], ['assets', 'assets?'], ['chains', 'chains?'], ['representations', 'representations?|tokens?']] as const) {
      if (new RegExp(String.raw`\b(?:${word})\b`).test(list)) {
        market[set] = catalogIds(set);
        notes.push(`"Approved ${set}" read as every reviewed ${set.replace(/s$/, '')} in the catalog.`);
      }
    }
  }

  if (/\b(?:no leverage|unleveraged|without leverage)\b/.test(p)) market['maxLeverage'] = '1';
  else {
    const lev = /(?:max(?:imum)?|at most|up to|no more than)\s*(\d{1,2}(?:\.\d)?)\s*x\s*leverage|leverage\s*(?:of\s*)?(?:max(?:imum)?|at most|up to|below|under|<=|≤)?\s*(\d{1,2}(?:\.\d)?)\s*x/.exec(p);
    if (lev !== null) market['maxLeverage'] = lev[1] ?? lev[2] ?? null;
  }
  const slip = /slippage[^.;\n]*?(\d+(?:\.\d+)?)\s*(bps|basis points|%)/.exec(p);
  if (slip !== null) {
    const n = slip[1] ?? '';
    const bps = slip[2] === '%' ? (/^\d+(\.\d{1,2})?$/.test(n) ? String(Math.round(Number(n) * 100)) : null) : /^\d+$/.test(n) ? n : null;
    if (bps === null) issues.push({ kind: 'AMBIGUOUS', field: 'market.maxSlippageBps', text: `Could not read slippage "${n}${slip[2] ?? ''}" exactly.` });
    market['maxSlippageBps'] = bps;
  }
  const quote = /quotes?[^.;\n]*?(?:older than|fresher than|within|max(?:imum)? age(?: of)?|at most|under)\s*(\d+)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)/.exec(p);
  if (quote !== null) market['maxQuoteAgeSeconds'] = String(Number(quote[1]) * (/^m/.test(quote[2] ?? '') ? 60 : 1));
  const validity = /\b(?:for|valid for|expires? in|over the next|lasting)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/.exec(p);
  if (validity !== null) {
    const n = Number(validity[1]);
    const unit = validity[2] ?? '';
    portfolio['validityMinutes'] = String(/^d/.test(unit) ? n * 1440 : /^h/.test(unit) ? n * 60 : n);
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

/** Ask a provider to interpret `prompt`. A failed or malformed answer yields no draft; nothing falls back silently. */
export async function interpretPrompt(prompt: string, provider: AgentModelProvider, clock: Clock, timeoutMs: number): Promise<Interpreted> {
  const outcome = await callModel({ provider, request: draftRequest(prompt.slice(0, 2_000)), parse: parseDraftInterpretation, timeoutMs, clock });
  return { outcome, draft: outcome.status === 'RESPONDED' ? draftFromInterpretation(outcome.value) : null };
}

export type { IssueKind };
