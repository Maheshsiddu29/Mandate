import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { draftFromInterpretation, interpretLocally, interpretLocallyAsText, interpretPrompt, parseDraftInterpretation, preferExplicitPrompt } from '../src/authoring/prompt-to-draft.ts';
import { applyPreset, emptyDraft } from '../src/authoring/draft-types.ts';
import { catalogIds } from '../src/authoring/catalog.ts';
import { realClock } from '../src/runtime/clock.ts';
import { ScriptedProvider, json } from './support/providers.ts';

const CANONICAL = 'Deploy up to $2,000 across stocks, swaps, yield and perps. Keep at least $200 unallocated. Perps exposure max $400. No synthetic stock exposure. Only approved issuers and venues.';

const draftOf = (prompt: string) => draftFromInterpretation(interpretLocally(prompt));

describe('prompt → draft (test 1: a prompt produces a structured draft)', () => {
  it('reads the canonical prompt into known fields, and nothing else', () => {
    const d = draftOf(CANONICAL);
    assert.equal(d.portfolio.totalCapital, '2000');
    assert.equal(d.portfolio.maxDeployed, '2000');
    assert.equal(d.portfolio.minUnallocated, '200');
    assert.equal(d.portfolio.maxDerivative, '400');
    assert.deepEqual([d.agents.stock.enabled, d.agents.swap.enabled, d.agents.yield.enabled, d.agents.perps.enabled], [true, true, true, true]);
    // Not named in the list: disabled, which is narrower, and explained.
    assert.equal(d.agents.nft.enabled, false);
    assert.ok(d.notes.some((n) => /disabled/.test(n)));
    assert.deepEqual(d.market.issuers, catalogIds('issuers'));
    assert.deepEqual(d.market.venues, catalogIds('venues'));
    assert.equal(d.provenance['portfolio.totalCapital'], 'INTERPRETED');
  });

  it('leaves every unstated field unset — no permissive default', () => {
    const d = draftOf(CANONICAL);
    assert.equal(d.portfolio.maxIlliquid, null);
    assert.equal(d.portfolio.validityMinutes, null);
    assert.equal(d.market.assets, null);
    assert.equal(d.market.maxLeverage, null);
    assert.equal(d.market.maxQuoteAgeSeconds, null);
    assert.equal(d.execution.recipients, null);
    assert.equal(d.agents.stock.maxAllocation, null);
    assert.equal(d.provenance['market.assets'], undefined);
  });

  it('a preset fills unset fields only when the principal asks, and says which', () => {
    const { draft, filled } = applyPreset(draftOf(CANONICAL), 'balanced', true);
    assert.ok(filled.includes('market.assets'));
    assert.ok(!filled.includes('portfolio.minUnallocated'));
    assert.equal(draft.portfolio.minUnallocated, '200');
    assert.equal(draft.provenance['market.assets'], 'PRESET');
  });
});

describe('contradictions and ambiguity stay unresolved', () => {
  it('"deploy everything but keep $500 free" is a CONFLICT', () => {
    const d = draftOf('Deploy everything but keep $500 free.');
    assert.equal(d.portfolio.deployAll, true);
    assert.equal(d.portfolio.minUnallocated, '500');
    assert.ok(d.issues.some((i) => i.kind === 'CONFLICT'));
  });

  it('"use safe stocks" needs clarification and decides nothing about safety', () => {
    const d = draftOf('Use safe stocks.');
    assert.ok(d.issues.some((i) => i.kind === 'NEEDS_CLARIFICATION' && /safe/.test(i.text)));
    assert.equal(d.market.assets, null);
    assert.equal(d.market.issuers, null);
  });

  it('assets outside the reviewed catalog are UNSUPPORTED, never added', () => {
    const d = draftOf('Deploy up to $1,000 into Tesla and Solana.');
    assert.equal(d.issues.filter((i) => i.kind === 'UNSUPPORTED').length, 2);
    assert.equal(d.market.assets, null);
  });
});

describe('the interpretation boundary', () => {
  const base = JSON.parse(interpretLocallyAsText(CANONICAL)) as { market: { venues: string[]; syntheticExposure: string | null } };

  it('drops identities the catalog does not contain', () => {
    const x = parseDraftInterpretation(json({ ...base, market: { ...base.market, venues: ['swap-router', 'router-0xbad0'] } }));
    assert.ok(x.ok);
    const d = draftFromInterpretation(x.value);
    assert.deepEqual(d.market.venues, ['swap-router']);
    assert.ok(d.issues.some((i) => i.kind === 'UNSUPPORTED' && /router-0xbad0/.test(i.text)));
  });

  it('cannot widen: synthetic exposure ALLOWED is reported, not applied', () => {
    const x = parseDraftInterpretation(json({ ...base, market: { ...base.market, syntheticExposure: 'ALLOWED' } }));
    assert.ok(x.ok);
    assert.ok(draftFromInterpretation(x.value).issues.some((i) => /Synthetic exposure is forbidden/.test(i.text)));
  });

  it('refuses output with a field the schema does not have', () => {
    assert.equal(parseDraftInterpretation(json({ ...base, signature: '0x00' })).ok, false);
    assert.equal(parseDraftInterpretation(json({ ...base, market: { ...base.market, recipientAddress: '0x9999' } })).ok, false);
    assert.equal(parseDraftInterpretation('not json').ok, false);
  });

  it('an unreadable amount stays unset and is flagged', () => {
    const raw = JSON.parse(interpretLocallyAsText(CANONICAL)) as { portfolio: { [k: string]: unknown } };
    const x = parseDraftInterpretation(json({ ...raw, portfolio: { ...raw.portfolio, totalCapital: 'about two grand' } }));
    assert.ok(x.ok);
    const d = draftFromInterpretation(x.value);
    assert.equal(d.portfolio.totalCapital, null);
    assert.ok(d.issues.some((i) => i.kind === 'AMBIGUOUS' && i.field === 'portfolio.totalCapital'));
  });
});

describe('test 2: a draft is not authority', () => {
  it('a draft carries no signature, digest or version', () => {
    const d = draftOf(CANONICAL);
    for (const k of Object.keys(d)) assert.doesNotMatch(k, /signature|digest|version|signed|active/i);
    assert.deepEqual(Object.keys(emptyDraft()).sort(), ['agents', 'execution', 'issues', 'market', 'notes', 'portfolio', 'provenance']);
  });

  it('a malformed model answer yields no draft, and nothing falls back silently', async () => {
    const provider = new ScriptedProvider({ interpret: () => ({ text: '{"portfolio": "everything"}' }) });
    const r = await interpretPrompt(CANONICAL, provider, realClock, 1_000);
    assert.equal(r.outcome.status, 'INVALID_RESPONSE');
    assert.equal(r.draft, null);
  });

  it('Let the Stock agent manage $800 populates stock and does not become the balanced total', () => {
    const d = draftOf('Let the Stock agent manage $800.');
    assert.equal(d.agents.stock.enabled, true);
    assert.equal(d.agents.stock.maxAllocation, '800');
    assert.equal(d.portfolio.totalCapital, '800');
    assert.equal(d.portfolio.maxDeployed, '800');
    assert.equal(d.agents.swap.enabled, false);
    assert.equal(d.agents.nft.enabled, false);
    assert.equal(d.agents.yield.enabled, false);
    assert.equal(d.agents.perps.enabled, false);
    const filled = applyPreset(d, 'balanced', true).draft;
    assert.equal(filled.portfolio.totalCapital, '800', 'a preset must not replace the amount the prompt stated');
    assert.equal(filled.agents.stock.maxAllocation, '800');
    assert.equal(d.provenance['portfolio.totalCapital'], 'INTERPRETED');
    assert.equal(Object.values(d).some((value) => typeof value === 'string' && /signature/.test(value)), false);
  });

  it('a multi-agent prompt keeps each named amount and the portfolio total apart', () => {
    const d = draftOf('Deploy $2,000 across stocks and yield. Stock $800. Yield $400.');
    assert.equal(d.portfolio.totalCapital, '2000');
    assert.equal(d.agents.stock.enabled, true);
    assert.equal(d.agents.yield.enabled, true);
    assert.equal(d.agents.stock.budget, '800');
    assert.equal(d.agents.yield.budget, '400');
    assert.equal(d.agents.stock.maxAllocation, null);
    assert.equal(d.agents.swap.enabled, false);
  });

  it('a model cannot replace an explicit prompt amount with $2,500', () => {
    const invented = interpretLocally('Deploy $2,500 across stocks.');
    assert.equal(invented.portfolio.totalCapital, '2500');
    const overlaid = preferExplicitPrompt(invented, 'Let the Stock agent manage $800.');
    const d = draftFromInterpretation(overlaid);
    assert.equal(d.portfolio.totalCapital, '800');
    assert.equal(d.agents.stock.maxAllocation, '800');
    assert.notEqual(d.portfolio.totalCapital, '2500');
  });

  it('a well-formed model answer is still only a draft', async () => {
    const provider = new ScriptedProvider({ interpret: () => ({ text: interpretLocallyAsText(CANONICAL) }) });
    const r = await interpretPrompt(CANONICAL, provider, realClock, 1_000);
    assert.equal(r.outcome.status, 'RESPONDED');
    assert.equal(r.draft?.portfolio.maxDerivative, '400');
    assert.equal(provider.requests[0]?.kind, 'DRAFT');
  });
});
