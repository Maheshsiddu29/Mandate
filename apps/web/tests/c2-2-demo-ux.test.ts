/**
 * C2.2 demo UX polish — semantic presentation assertions
 * (docs/demo/c2-2-demo-ux-polish.md).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { progressStep } from '../components/demo/live/live-flow.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compose = read('../components/demo/live/stage-compose.tsx');
const configure = read('../components/demo/live/stage-configure.tsx');
const planning = read('../components/demo/live/stage-planning.tsx');
const agents = read('../components/demo/live/stage-agents.tsx');
const outcome = read('../components/demo/live/stage-outcome.tsx');
const lab = read('../components/demo/live/live-lab.tsx');
const css = read('../components/demo/live/live-workspace.css');
const flow = read('../components/demo/live/live-flow.ts');

test('Compose hierarchy: product question, real interpretation states, judge examples', () => {
  assert.match(compose, /What do you want your agents to do\?/);
  assert.match(compose, /Interpreting mandate/);
  assert.match(compose, /Checking limits/);
  assert.match(compose, /Ready to review/);
  assert.match(compose, /Let Stock and Yield manage \$2,000 conservatively/);
  assert.doesNotMatch(compose, /Thinking\.\.\.|Running AI|Analyzing blockchain/i);
});

test('Review authorize copy and issue categories', () => {
  assert.match(configure, /You&apos;re authorizing|AUTHORIZE AUTONOMOUS MANDATE/);
  assert.match(configure, /Agents cannot exceed it/);
  assert.match(configure, /Needs input/);
  assert.match(configure, /Not supported/);
  assert.match(configure, /Refused/);
  assert.match(configure, /Authorize mandate/);
  assert.match(configure, /Trusted execution details/);
});

test('Planning Room vs single-agent Agent plan', () => {
  assert.match(planning, /Planning Room/);
  assert.match(planning, /Agent plan/);
  assert.match(planning, /Use this plan/);
  assert.match(planning, /Keep available|Available/);
  assert.doesNotMatch(planning, /singleAgent \? "Mandate Room"/);
});

test('Mandate active and action-state language', () => {
  assert.match(agents, /Mandate active/);
  assert.match(agents, /Agents can act only within the authority you approved/);
  assert.match(agents, /mw-authority-map/);
  assert.match(agents, /NO ACTION|Capital remains available/);
  assert.match(agents, /AUTHORIZED/);
  assert.match(agents, /BLOCKED/);
  assert.match(agents, /PROPOSED/);
  assert.match(outcome, /Mandate stopped this before execution/);
  assert.match(outcome, /Wallet request: None/);
});

test('Settlement progress, held, receipt hierarchy, start new mandate', () => {
  assert.match(outcome, /Checking authorization/);
  assert.match(outcome, /Sign execution/);
  assert.match(outcome, /Simulating/);
  assert.match(outcome, /Submitting/);
  assert.match(outcome, /Confirmed/);
  assert.match(outcome, /Execute on Robinhood Testnet/);
  assert.match(outcome, /Testnet settlement proof/);
  assert.match(outcome, /Agent outcomes/);
  assert.match(outcome, /Settlement evidence/);
  assert.match(outcome, /Start new mandate/);
  assert.match(outcome, /Review details/);
  assert.match(outcome, /Test the firewall/);
  assert.doesNotMatch(outcome, />Run again</);
  assert.doesNotMatch(outcome, /Awaiting operator authorization/i);
  assert.match(lab, /rememberSession\(null\)/);
  assert.match(lab, /window\.location\.assign\(window\.location\.pathname\)/);
});

test('No spine/operator jargon in primary demo surfaces', () => {
  assert.doesNotMatch(compose + agents + planning, /\bspine\b|Phase 7|candidateDigest|reservation lineage/i);
  assert.doesNotMatch(lab, /V2 settlement spine/);
  assert.match(lab, /cannot settle from the browser/);
  // API still uses spine V2/V3 — that is not user-facing copy.
  assert.match(lab, /"V2"/);
  assert.match(lab, /preferV3 \? "V3" : "V2"/);
});

test('progress cue and reduced-motion stage transitions remain', () => {
  assert.equal(progressStep('PROMPT'), 'Define');
  assert.equal(progressStep('APPROVE'), 'Authorize');
  assert.equal(progressStep('AGENTS_WORKING'), 'Live');
  assert.equal(progressStep('COMPLETE'), 'Receipt');
  assert.match(flow, /export function progressStep/);
  assert.match(lab, /mw-progress/);
  assert.match(lab, /data-reduced=\{reduced \? "" : undefined\}/);
  assert.match(css, /\.mw-authority-map/);
  assert.match(css, /\.mw-progress/);
});

test('MDUSD → MDEMO direction and fixture qualification stay honest', () => {
  assert.match(outcome, /Fixture debit \{settlement\.fixtureIn\}/);
  assert.match(outcome, /Fixture output \{settlement\.fixtureOut\}/);
  assert.match(outcome, /FIXTURE_QUALIFICATION|valueless demo assets|not an NVDA trade/i);
  assert.doesNotMatch(outcome, /Buy NVDA|Robinhood Stock Token trade/i);
});
