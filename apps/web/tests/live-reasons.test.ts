import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { code, type JsonRecord, type LiveEvent } from '../components/demo/live/live-client.ts';
import { deriveAgents, deriveReview, deriveStress, explainReasons, OUTSIDE_MARKET_SET, reasonCodes, reasonLabel } from '../components/demo/live/live-model.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const LIVE = '../components/demo/live/';
const agentsUi = read(`${LIVE}stage-agents.tsx`);
const sheets = read(`${LIVE}sheets.tsx`);
const outcome = read(`${LIVE}stage-outcome.tsx`);

/** Reasons exactly as the runtime emits them: `${code}:${subject}`, the registry's subject a full representation id. */
const NVDA_B = 'eip155:46630/erc20:0x2222222222222222222222222222222222222222';
const STOCK_RAW = [`REGISTRY:ISSUER_NOT_ALLOWED:${NVDA_B}`, `REGISTRY:SYNTHETIC_NOT_ALLOWED:${NVDA_B}`];
const YIELD_RAW = ['ASSET_NOT_ALLOWED:assets', 'ISSUER_NOT_ALLOWED:issuers', 'REPRESENTATION_NOT_ALLOWED:representations', 'VENUE_NOT_ALLOWED:venues'];

function event(sequence: number, kind: string, data: JsonRecord = {}, agent: string | null = null): LiveEvent {
  return { schema: 'MANDATE_LIVE_AI.V1', sessionId: 'lab-1', sequence, kind, at: '2026-10-02T00:00:00.000Z', elapsedMs: sequence * 100, protocolTime: '0', mandateVersion: 1, agent, roomId: null, generation: null, data };
}

test('a registry code keeps its component and its specific code: never bare REGISTRY', () => {
  assert.equal(code(STOCK_RAW[0] as string), 'REGISTRY:ISSUER_NOT_ALLOWED');
  assert.equal(code('LEDGER:AUTHORITY_INVALID/AUTHORITY_REVOKED'), 'LEDGER:AUTHORITY_INVALID/AUTHORITY_REVOKED');
  assert.equal(code('VENUE_NOT_ALLOWED:venues:0xabc'), 'VENUE_NOT_ALLOWED');
  assert.deepEqual(reasonCodes(STOCK_RAW), ['REGISTRY:ISSUER_NOT_ALLOWED', 'REGISTRY:SYNTHETIC_NOT_ALLOWED']);
});

test('the blocked look-alike stock: specific words first, both raw codes under Technical details', () => {
  const r = explainReasons(STOCK_RAW);
  assert.equal(r.headline, 'Synthetic representation not approved');
  assert.deepEqual(r.labels, ['Issuer not approved', 'Synthetic representation not approved']);
  assert.deepEqual(r.codes, ['REGISTRY:ISSUER_NOT_ALLOWED', 'REGISTRY:SYNTHETIC_NOT_ALLOWED']);
  assert.ok(![r.headline, ...r.labels].includes('Registry'));
});

test('the card for a registry refusal: specific reasons, a hard block, and no concatenated codes', () => {
  const events = [
    event(0, 'AGENT_CANDIDATES_EVALUATED', { basis: 'ADVISORY', discovered: ['nvda-note-a'], actionable: ['nvda-note-a'], excluded: [] }, 'stock'),
    event(1, 'AGENT_REQUEST_STARTED', {}, 'stock'),
    event(2, 'AGENT_DECISION_COMPLETED', { candidateId: 'nvda-token-b', candidate: 'NVDA · NVIDIA Stock Token', requested: { atoms: '700000000', amount: '700' }, rationale: 'lower quoted price' }, 'stock'),
    event(3, 'PROPOSAL_BLOCKED', { reasons: STOCK_RAW, individuallyValid: false }, 'stock'),
  ];
  const stock = deriveAgents(events).find((a) => a.role === 'stock');
  assert.equal(stock?.phase, 'BLOCKED');
  assert.deepEqual(stock?.reasons, ['REGISTRY:ISSUER_NOT_ALLOWED', 'REGISTRY:SYNTHETIC_NOT_ALLOWED']);
  assert.equal(stock?.hardBlock, true);
  assert.ok(!(stock?.reasons ?? []).includes('REGISTRY'));
  assert.doesNotMatch((stock?.reasons ?? []).join(''), /REGISTRYREGISTRY/);
  assert.equal(deriveReview(events).blockedItems[0]?.reason, 'Synthetic representation not approved');
});

test('several reasons render one by one: a market-set headline, each reason in words, each code separately', () => {
  const r = explainReasons(YIELD_RAW);
  assert.equal(r.headline, OUTSIDE_MARKET_SET);
  assert.deepEqual(r.labels, ['Asset not approved', 'Issuer not approved', 'Representation not approved', 'Venue not allowed']);
  assert.deepEqual(r.codes, ['ASSET_NOT_ALLOWED', 'ISSUER_NOT_ALLOWED', 'REPRESENTATION_NOT_ALLOWED', 'VENUE_NOT_ALLOWED']);
  // Quantity reasons are not a market-set refusal.
  assert.equal(explainReasons(['AGENT_LIMIT_EXCEEDED:portfolio-notional', 'PORTFOLIO_LIMIT_EXCEEDED:portfolio-notional', 'VENUE_NOT_ALLOWED:venues']).headline, 'Venue not allowed');
});

test('duplicate reasons are shown once, in a deterministic order', () => {
  const r = explainReasons(['VENUE_NOT_ALLOWED:venues:a', 'VENUE_NOT_ALLOWED:venues:b', 'ROUTE_NOT_ALLOWED:route:0x1', 'VENUE_NOT_ALLOWED:venues:a']);
  assert.deepEqual(r.codes, ['VENUE_NOT_ALLOWED', 'ROUTE_NOT_ALLOWED']);
  assert.deepEqual(r.labels, ['Venue not allowed', 'Route not allowed']);
  assert.deepEqual(explainReasons([...YIELD_RAW]), explainReasons([...YIELD_RAW]));
});

test('web-only words for every protocol code the Live Lab shows; the codes themselves are unchanged', () => {
  for (const [raw, words] of [
    ['REGISTRY:ISSUER_NOT_ALLOWED', 'Issuer not approved'],
    ['REGISTRY:SYNTHETIC_NOT_ALLOWED', 'Synthetic representation not approved'],
    ['REGISTRY:REPRESENTATION_NOT_ALLOWED', 'Representation not approved'],
    ['REGISTRY:ASSET_NOT_ALLOWED', 'Asset not approved'],
    ['ASSET_NOT_ALLOWED', 'Asset not approved'],
    ['ISSUER_NOT_ALLOWED', 'Issuer not approved'],
    ['REPRESENTATION_NOT_ALLOWED', 'Representation not approved'],
    ['VENUE_NOT_ALLOWED', 'Venue not allowed'],
    ['RECIPIENT_NOT_ALLOWED', 'Recipient not allowed'],
    ['PORTFOLIO_LIMIT_EXCEEDED', 'Portfolio limit exceeded'],
    ['AGENT_LIMIT_EXCEEDED', 'Agent limit exceeded'],
    ['ALLOCATION_INSUFFICIENT', 'Insufficient portfolio authority'],
  ] as const) assert.equal(reasonLabel(raw), words, raw);
  // A bare subsystem name, if one ever arrived, still reads as a sentence.
  assert.notEqual(reasonLabel('REGISTRY'), 'Registry');
});

test('the UI shows words first and keeps each raw code in its own element under Technical details', () => {
  assert.match(agentsUi, /export function MandateReasons/);
  assert.match(agentsUi, /<summary>\{summary\}<\/summary>\s*<ul className="mw-codes">\{codes\.map\(\(reasonCode\) => <li key=\{reasonCode\}><code>\{reasonCode\}<\/code><\/li>\)\}<\/ul>/);
  assert.match(agentsUi, /summary = "Technical details"/);
  assert.match(agentsUi, /<ul className="mw-reasons" aria-label="Reasons">/);
  assert.match(agentsUi, /line: explainReasons\(agent\.reasons\)\.headline \|\| "Blocked"/);
  // No surface maps reasons straight into adjacent <code> elements any more, and none leads with the first raw code.
  for (const source of [agentsUi, sheets, outcome]) {
    assert.doesNotMatch(source, /reasons\.map\(\(reason\) => <code/);
    assert.doesNotMatch(source, /reasonLabel\(\w+\.reasons\[0\]/);
  }
  // Human words precede the disclosure in the Mandate layer.
  assert.ok(agentsUi.indexOf('<strong>{verdict?.line ?? "Checked"}</strong>') < agentsUi.indexOf('<MandateReasons reasons={agent.reasons} />'));
});

test('the security demo still reports a registry refusal truthfully', () => {
  const events = [
    event(0, 'POLICY_STRESS_STARTED', {}, 'swap'),
    event(1, 'POLICY_STRESS_CASE_SELECTED', { attempt: 1, caseId: 'REPRESENTATION_MISMATCH', rationale: 'test the registry' }, 'swap'),
    event(2, 'POLICY_STRESS_PROPOSAL_BLOCKED', { attempt: 1, reasons: STOCK_RAW, screening: { verdict: 'BLOCKED' } }, 'swap'),
  ];
  const [attempt] = deriveStress(events).attempts;
  assert.equal(attempt?.outcome, 'REFUSED');
  assert.deepEqual(attempt?.reasons, ['REGISTRY:ISSUER_NOT_ALLOWED', 'REGISTRY:SYNTHETIC_NOT_ALLOWED']);
  assert.equal(explainReasons(attempt?.reasons ?? []).headline, 'Synthetic representation not approved');
  assert.match(sheets, /explainReasons\(attempt\.reasons\)\.headline/);
});

test('eligibility is evidence, not the trade flow: discovery-only candidates and a model-free abstention', () => {
  const events = [
    event(0, 'AGENT_CANDIDATES_EVALUATED', { basis: 'ADVISORY', discovered: ['nvda-note-a', 'nvda-token-b'], actionable: ['nvda-note-a'], excluded: [{ candidateId: 'nvda-token-b', candidate: 'NVDA · NVIDIA Stock Token', reasons: STOCK_RAW }] }, 'stock'),
    event(1, 'AGENT_REQUEST_STARTED', { candidates: ['nvda-note-a'] }, 'stock'),
    event(2, 'AGENT_CANDIDATES_EVALUATED', { basis: 'ADVISORY', discovered: ['high-yield-usd'], actionable: [], excluded: [{ candidateId: 'high-yield-usd', candidate: 'High-Yield USD deposit', reasons: YIELD_RAW }] }, 'yield'),
    event(3, 'AGENT_ABSTAINED', { rationale: 'No eligible opportunities under this mandate.', cause: 'NO_ACTIONABLE_CANDIDATES', modelCalled: false }, 'yield'),
  ];
  const agents = deriveAgents(events);
  const stock = agents.find((a) => a.role === 'stock');
  assert.deepEqual(stock?.eligibility?.actionable, ['nvda-note-a']);
  assert.deepEqual(stock?.eligibility?.excluded.map((x) => [x.candidateId, x.codes]), [['nvda-token-b', ['REGISTRY:ISSUER_NOT_ALLOWED', 'REGISTRY:SYNTHETIC_NOT_ALLOWED']]]);
  const yieldAgent = agents.find((a) => a.role === 'yield');
  assert.equal(yieldAgent?.phase, 'ABSTAINED');
  assert.equal(yieldAgent?.rationale, 'No eligible opportunities under this mandate.');
  assert.deepEqual(yieldAgent?.eligibility?.actionable, []);
  // Both were evaluated; the abstention is a quiet outcome, not a block.
  const review = deriveReview(events);
  assert.equal(review.evaluated, 2);
  assert.equal(review.blocked, 0);
  // The candidates view lives in the Evidence tab only.
  assert.match(sheets, /\{tab === "Evidence" \? <CandidateEvidence agents=\{props\.agents\} \/> : null\}/);
  assert.match(sheets, /DISCOVERY ONLY/);
  assert.doesNotMatch(agentsUi, /CandidateEvidence|DISCOVERY ONLY/);
});
