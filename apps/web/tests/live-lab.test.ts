import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { conflicts, liveServerUrl } from '../components/demo/live/live-client.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const LIVE_DIR = new URL('../components/demo/live/', import.meta.url);
const liveSources = readdirSync(LIVE_DIR)
  .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  .map((f) => ({ file: f, text: readFileSync(new URL(f, LIVE_DIR), 'utf8') }));

test('the Live AI Lab is a separate route; Protocol Replay is unchanged', () => {
  const live = read('../app/demo/live/page.tsx');
  const replay = read('../app/demo/page.tsx');
  assert.match(live, /<LiveLab\s*\/>/);
  assert.match(replay, /<JudgeExperience\s*\/>/);
  assert.doesNotMatch(replay, /LiveLab|live-client/);
});

test('the browser holds no key and never talks to a model provider', () => {
  for (const { file, text } of liveSources) {
    assert.doesNotMatch(text, /api\.openai\.com|OPENAI_API_KEY|OPENAI_MODEL|\bsk-[A-Za-z0-9]{8}|['"]authorization['"]\s*:|\bBearer\s/i, file);
    assert.doesNotMatch(text, /@mandate\/live-agents|packages\/live-agents/, file);
    assert.doesNotMatch(text, /sendTransaction|signTransaction|eth_sign|privateKey/i, file);
  }
  // The only public configuration is the local server's URL.
  const env = liveSources.flatMap(({ text }) => [...text.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(env)], ['NEXT_PUBLIC_LIVE_AGENTS_URL']);
  // Network access goes through the one client module.
  for (const { file, text } of liveSources) if (file !== 'live-client.ts') assert.doesNotMatch(text, /\bfetch\(|new EventSource/, file);
});

test('the browser talks only to a loopback server', () => {
  assert.equal(liveServerUrl(undefined), 'http://127.0.0.1:8787');
  assert.equal(liveServerUrl(''), 'http://127.0.0.1:8787');
  assert.equal(liveServerUrl('http://localhost:9000/'), 'http://localhost:9000');
  for (const bad of ['https://api.openai.com', 'http://evil.example:8787', 'https://127.0.0.1:8787', 'file:///etc/passwd', 'not a url', 'http://127.0.0.1.evil.example']) assert.equal(liveServerUrl(bad), null, bad);
});

test('the policy stress panel uses neutral wording and shows the real result', () => {
  const ui = read('../components/demo/live/sheets.tsx');
  assert.match(ui, /Test the firewall/);
  assert.match(ui, /VALID AGENT ≠ VALID ACTION/);
  for (const row of ['Identity', 'Membership', 'Delegation', 'Signature', 'DIFFERENT AUTHORIZATION RESULT']) assert.match(ui, new RegExp(row));
  assert.doesNotMatch(ui, /hacker|escaped|jailbreak|rogue/i);
});

test('the Room log shows typed-resource conflicts per resource, and their resolution', () => {
  const v = (amount: string) => ({ atoms: `${amount}000000`, amount });
  const open = [{ resource: 'derivative-notional', authority: v('400'), demand: v('600'), requiredReduction: v('200') }];
  assert.equal(conflicts(open), 'derivative-notional 600 USDC > 400 USDC (reduce 200 USDC)');
  const done = [{ ...open[0]!, demandAfter: v('400'), remainingReduction: v('0'), status: 'SATISFIED' }];
  assert.equal(conflicts(done), 'derivative-notional 600 USDC → 400 USDC ≤ 400 USDC SATISFIED');
  // Two resources stay two lines; there is no total.
  const two = [...open, { resource: 'portfolio-notional', authority: v('2000'), demand: v('2500'), requiredReduction: v('500') }];
  assert.equal(conflicts(two), 'derivative-notional 600 USDC > 400 USDC (reduce 200 USDC); portfolio-notional 2500 USDC > 2000 USDC (reduce 500 USDC)');
  assert.equal(conflicts(undefined), '');
  const room = read('../components/demo/live/room-chat.tsx');
  assert.match(room, /shown\.map\(\(line\)/);
  assert.match(room, /Incomparable reductions are not added together/);
  assert.doesNotMatch(room, /requiredReductionTotal|totalReduction/);
});
