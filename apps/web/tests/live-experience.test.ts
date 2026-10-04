import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { JsonRecord, LiveEvent } from '../components/demo/live/live-client.ts';
import { deriveFlow, eventsAfter, type FlowInput } from '../components/demo/live/live-flow.ts';
import {
  actionText,
  allocationSummary,
  awaitingReplies,
  blockedInsideRoom,
  derivePresentation,
  deriveReview,
  deriveRoomChat,
  formatDuration,
  groupEventsByElapsed,
  proposedPortfolio,
  reasonLabel,
  resourceLines,
  usd,
  type RoleName,
} from '../components/demo/live/live-model.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const LIVE = '../components/demo/live/';
const lab = read(`${LIVE}live-lab.tsx`);
const compose = read(`${LIVE}stage-compose.tsx`);
const configure = read(`${LIVE}stage-configure.tsx`);
const agentsUi = read(`${LIVE}stage-agents.tsx`);
const room = read(`${LIVE}room-chat.tsx`);
const outcome = read(`${LIVE}stage-outcome.tsx`);
const sheets = read(`${LIVE}sheets.tsx`);
const shared = read(`${LIVE}workspace-ui.tsx`);
const css = read(`${LIVE}live-workspace.css`);
const model = read(`${LIVE}live-model.ts`);
const flowSource = read(`${LIVE}live-flow.ts`);
const prompt = read('../components/react-bits/prompt-bar.tsx');
const lattice = read('../components/react-bits/lattice-loader.tsx');
const latticeCss = read('../components/react-bits/lattice-loader.css');
const replay = read('../app/demo/page.tsx');
const liveDir = new URL(LIVE, import.meta.url);
const browserSources = readdirSync(liveDir).filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => readFileSync(new URL(file, liveDir), 'utf8')).join('\n');

/** The real stub run (B.6.2 capture), trimmed to the fields the browser reads. */
const run: LiveEvent[] = JSON.parse(read('./fixtures/live-stub-run.json'));
const usdc = (amount: string): JsonRecord => ({ atoms: `${amount}000000`, amount });

function event(sequence: number, kind: string, data: JsonRecord = {}, agent: string | null = null, extra: Partial<LiveEvent> = {}): LiveEvent {
  return { schema: 'MANDATE_LIVE_AI.V1', sessionId: 'lab-1', sequence, kind, at: '2026-09-30T00:00:00.000Z', elapsedMs: sequence * 1000, protocolTime: '0', mandateVersion: 1, agent, roomId: extra.roomId ?? null, generation: extra.generation ?? null, data, ...extra };
}

const idle: FlowInput = { drafting: false, draftPresent: false, reviewing: false, activeVersion: null, amending: false, runStarted: false, task: null, lastRunStatus: null, lastError: null, runEvents: [], paused: false };
const running = (runEvents: readonly LiveEvent[], task: string | null = 'RUN'): FlowInput => ({ ...idle, draftPresent: true, activeVersion: 1, runStarted: true, task, runEvents });
const upTo = (sequence: number) => eventsAfter(run.filter((item) => item.sequence <= sequence), 4);

test('the first screen is one prompt: no agents, limits, Room, settlement or log', () => {
  assert.equal(deriveFlow(idle).phase, 'PROMPT');
  assert.match(compose, /What do you want your agents to do\?/);
  assert.match(compose, /<PromptBar[\s\S]*tone="light"/);
  assert.match(compose, /Example mandates/);
  for (const chip of ['Let Stock and Yield manage $2,000 conservatively.', 'Stock can use $1,000. Keep half of the capital untouched.', 'Let the Stock agent manage $800.']) assert.ok(compose.includes(chip), chip);
  assert.doesNotMatch(compose, /AgentConfigRow|Advanced permissions|RoomChat|Settlement|EventLog/);
});

test('the five-step stepper is gone; a quiet status line remains', () => {
  assert.doesNotMatch(lab, /live-stepper|Demo progression|const STEPS|StageShell/);
  assert.match(lab, /className="mw-bar__status"/);
  assert.equal(deriveFlow({ ...idle, drafting: true }).status, 'Interpreting');
  assert.equal(deriveFlow(running(upTo(30))).status, 'Live');
});

test('submitting the prompt shows drafting only while the real request is open', () => {
  assert.equal(deriveFlow({ ...idle, drafting: true }).phase, 'DRAFTING');
  assert.match(lab, /setDrafting\(true\);[\s\S]*await api\(SERVER, "POST", `\/sessions\/\$\{id\}\/draft`[\s\S]*setDrafting\(false\)/);
  assert.match(compose, /<LatticeLoader label="Interpreting mandate…" status="working"/);
  assert.match(compose, /Interpreting mandate/);
});

test('no timer, delay or randomness drives any state', () => {
  for (const source of [browserSources, prompt, lattice]) {
    assert.doesNotMatch(source, /setTimeout\(|Math\.random\(/);
  }
  // The only intervals read real status (an open server task) or tick an elapsed clock for open requests.
  assert.match(lab, /if \(task === null\) return undefined;[\s\S]*setInterval\(\(\) => void refresh\(\), 700\)/);
  assert.match(lab, /if \(!pending\) return undefined;[\s\S]*setInterval\(\(\) => setNow\(Date\.now\(\)\), 250\)/);
  assert.match(lattice, /authoritative elapsed telemetry/);
  assert.match(latticeCss, /prefers-reduced-motion/);
});

test('a ready draft becomes the agent team; five ceilings are editable and disabled means no authority', () => {
  assert.equal(deriveFlow({ ...idle, draftPresent: true }).phase, 'CONFIGURE');
  assert.match(configure, /ROLES\.map\(\(role\) => <AgentConfigRow/);
  assert.match(configure, /`agents\.\$\{role\}\.maxAllocation`/);
  assert.match(configure, /`agents\.\$\{role\}\.enabled`, enabled !== true/);
  assert.match(configure, /role="switch"/);
  assert.match(configure, /No authority · cannot propose/);
  assert.match(agentsUi, /No authority\. This agent cannot propose\./);
  assert.match(configure, /Mandate never fills a missing limit on its own\./);
  assert.match(configure, /Use balanced defaults/);
});

test('capital allocation compares agent ceilings to deployable capital, and only capital', () => {
  const fits = allocationSummary({ capital: '2000', maxDeployed: '2000', ceilings: ['600', '300', '200', '500', '200'] });
  assert.equal(fits.ceilings, 1800);
  assert.equal(fits.unassigned, 200);
  assert.equal(fits.oversubscribed, false);
  assert.equal(fits.fill, 0.9);
  const over = allocationSummary({ capital: '2000', maxDeployed: '2000', ceilings: ['800', '500', '400', '800', '600'] });
  assert.equal(over.ceilings, 3100);
  assert.equal(over.oversubscribed, true);
  assert.equal(over.unassigned, null);
  assert.equal(allocationSummary({ capital: '2000', maxDeployed: null, ceilings: ['800', null] }).ceilings, null);
  assert.match(model, /Only the capital dimension; derivative, illiquid and other typed limits/);
  assert.equal(usd('300.6'), '$300.60');
  assert.equal(usd('3100'), '$3,100');
});

test('advanced permissions start closed and open as an accessible dialog', () => {
  assert.match(lab, /useState<SheetName>\(null\)/);
  assert.match(lab, /title="Edit permissions"/);
  assert.match(shared, /dialog\.showModal\(\)/);
  assert.match(shared, /aria-labelledby=\{id\}/);
  assert.match(shared, /aria-label=\{`Close \$\{title\}`\}/);
  for (const section of ['Capital', 'Exposure', 'Assets & venues', 'Execution limits', 'Agents']) assert.match(configure, new RegExp(`title: "${section}"`));
  for (const status of ['From your prompt', 'Default', 'Edited']) assert.ok(configure.includes(status), status);
  assert.match(configure, /What Mandate enforces/);
});

test('an open sheet scrolls its own body and does not hand the wheel to the page', () => {
  assert.match(shared, /data-lenis-prevent=""/);
  assert.match(shared, /data-sheet-open/);
  assert.match(css, /dialog\.mw-sheet \{[\s\S]*overflow: hidden;/);
  assert.match(css, /html\[data-sheet-open\]/);
  assert.match(css, /\.mw-sheet__body \{[\s\S]*overflow-y: auto;[\s\S]*overscroll-behavior: contain;/);
  const smooth = read('../components/layout/smooth-scroll.tsx');
  assert.match(smooth, /lenis\.stop\(\)/);
  assert.match(smooth, /data-sheet-open/);
});

test('Trade is the one dominant action on the agent team', () => {
  const stage = configure.slice(configure.indexOf('export function ConfigureStage'), configure.indexOf('export function ApproveStage'));
  assert.equal(stage.match(/className="mw-cta"/g)?.length, 1);
  assert.match(stage, /Review &amp; Trade/);
  assert.doesNotMatch(stage, /AUTHORIZE MANDATE/);
});

test('the review step signs with a real wallet, or with the labelled demo key — never a faked approval', () => {
  assert.equal(deriveFlow({ ...idle, draftPresent: true, reviewing: true }).phase, 'APPROVE');
  assert.match(configure, /Mandate review/);
  assert.match(configure, /Approve in wallet/);
  assert.match(configure, /Your wallet will sign this Mandate\. This does not submit a blockchain transaction\./);
  assert.match(configure, /Authorize mandate/);
  assert.match(configure, /No browser wallet detected/);
  assert.match(configure, /your signature does not delegate onchain execution authority/);
  // The demo key stays, labelled as what it is.
  assert.match(configure, /Demo principal key/);
  assert.match(configure, /it secures nothing and is not a wallet signature/);
  assert.match(configure, /const matches = confirmation === props\.expected/);
  assert.match(configure, /const reviewClean = props\.review\.canAuthorize/);
  assert.match(configure, /disabled=\{!demoReady \|\| props\.authorizing\}/);
  // The wallet's CTA needs a connected wallet on the approval chain and a clean Review; nothing pretends to be connected.
  assert.match(configure, /const walletReady = signingMethod === "wallet" && connected && rightChain && reviewClean;/);
  assert.match(configure, /disabled=\{!walletReady \|\| props\.authorizing\}/);
  assert.doesNotMatch(browserSources, /Wallet approved|setConfirmation\(props\.expected\)|confirmation: expected/i);
  // Signing a mandate is not a transaction: the review step shows no gas estimate or limit.
  assert.doesNotMatch(configure, /gas estimate|gasEstimate|estimateGas|gasLimit/i);
  // The wallet path: a server challenge, the wallet's EIP-712 signature, server verification; the browser sends only id and signature.
  assert.match(lab, /call\("POST", "\/wallet\/challenge", \{ address, spine: preferV3 \? "V3" : "V2" \}\)/);
  assert.match(lab, /api\(SERVER, "GET", "\/settlement"\)/);
  assert.match(lab, /mode: "SEND", intent: "EXECUTE_ROBINHOOD_TESTNET"/);
  assert.match(lab, /gateSignature: signed\.value/);
  assert.match(lab, /cancel: true/);
  assert.match(lab, /gate\.mode !== "SEND"/);
  assert.doesNotMatch(lab, /sendAuthorization|tokenIn:|calldata/);
  assert.match(lab, /npm run agents:lab/);
  assert.match(outcome, /Sign execution/);
  assert.match(outcome, /Sign execution authorization/);
  assert.match(outcome, /Nothing is broadcast\./);
  assert.match(outcome, /Execute on Robinhood Testnet/);
  assert.match(outcome, /Testnet settlement proof/);
  assert.match(outcome, /\{settlement\.fixtureIn\} → \{settlement\.fixtureOut/);
  assert.doesNotMatch(outcome, /MDEMO → MDUSD/);
  assert.doesNotMatch(outcome, /Send testnet transaction/);
  assert.doesNotMatch(browserSources, /live-settlement|eth_sendTransaction|sendTransaction/);
  assert.match(lab, /w\.signTypedData\(address, challenge\.typedData\)/);
  assert.match(lab, /call\("POST", "\/wallet\/authorize", \{ challenge: str\(challenge\.challenge\), signature: signed\.value \}\)/);
  assert.doesNotMatch(lab, /console\.|localStorage\.setItem\([^)]*signature/);
});

test('cancelling the review returns to the agent team and activates nothing', () => {
  assert.match(lab, /onCancel=\{\(\) => \{\s*setReviewing\(false\);/);
  assert.match(lab, /Approval cancelled\. No mandate was activated\./);
  assert.equal(deriveFlow({ ...idle, draftPresent: true, reviewing: false }).phase, 'CONFIGURE');
});

test('signing starts the run; Trade never broadcasts anything', () => {
  assert.match(lab, /const body = await call\("POST", "\/authorize", \{ confirmation \}\);[\s\S]*await startRun\(body\);/);
  assert.match(lab, /const body = await call\("POST", "\/wallet\/authorize"[\s\S]*await startRun\(body\);/);
  assert.match(lab, /setRunFrom\(known\);\s*await call\("POST", "\/run", \{\}\);/);
  assert.doesNotMatch(browserSources, /sendTransaction|signTransaction|eth_sendRawTransaction|eth_sign(?!TypedData_v4)|personal_sign/i);
});

test('agent rows start from AGENT_REQUEST_STARTED and update independently', () => {
  const before = derivePresentation(eventsAfter(run.filter((item) => item.sequence <= 4), 4));
  assert.deepEqual(before.agents.map((agent) => agent.phase), ['WAITING', 'WAITING', 'WAITING', 'WAITING', 'WAITING']);
  const midway = derivePresentation(upTo(20)).agents;
  assert.equal(midway.find((agent) => agent.role === 'stock')?.phase, 'ADMISSIBLE');
  assert.equal(midway.find((agent) => agent.role === 'swap')?.phase, 'BLOCKED');
  assert.equal(midway.find((agent) => agent.role === 'yield')?.phase, 'RESPONDING');
  assert.equal(midway.find((agent) => agent.role === 'perps')?.phase, 'RESPONDING');
  assert.equal(deriveFlow(running(upTo(20))).phase, 'AGENTS_WORKING');
  assert.equal(deriveFlow(running(upTo(28))).phase, 'MANDATE_REVIEW');
  assert.match(agentsUi, /<LatticeLoader label=\{agent\.phase === "RESPONDING" \? "Responding…" : agent\.activity\} status="working"/);
});

test('the model proposal and the Mandate verdict stay separate layers, words first and codes in details', () => {
  assert.match(agentsUi, /mw-layer mw-layer--model/);
  assert.match(agentsUi, /mw-layer mw-layer--mandate/);
  assert.match(agentsUi, /Checking with Mandate…/);
  assert.match(agentsUi, /Technical detail/);
  for (const [raw, words] of [
    ['VENUE_NOT_ALLOWED:venues:x', 'Venue not allowed'], ['ASSET_NOT_ALLOWED', 'Asset not approved'], ['ISSUER_NOT_ALLOWED', 'Issuer not approved'],
    ['REPRESENTATION_NOT_ALLOWED', 'Representation not approved'], ['RECIPIENT_NOT_ALLOWED', 'Recipient not allowed'], ['INSTRUMENT_UNKNOWN', 'Unknown instrument'],
    ['PORTFOLIO_LIMIT_EXCEEDED', 'Portfolio limit exceeded'], ['AGENT_LIMIT_EXCEEDED', 'Agent limit exceeded'], ['ALLOCATION_INSUFFICIENT', 'Insufficient portfolio authority'],
  ] as const) assert.equal(reasonLabel(raw), words);
  const swap = derivePresentation(run).agents.find((agent) => agent.role === 'swap');
  assert.deepEqual(swap?.reasons, ['VENUE_NOT_ALLOWED']);
  assert.equal(swap?.inRoom, false);
});

test('a hard-blocked action never joins the Room, and a portfolio conflict opens it without a click', () => {
  assert.equal(blockedInsideRoom(run), false);
  assert.equal(deriveFlow(running(upTo(29))).phase, 'ROOM');
  assert.doesNotMatch(lab, /Open Room/);
  assert.equal(derivePresentation(run).agents.find((agent) => agent.role === 'perps')?.portfolioConflict, true);
});

test('Room messages are translations of real structured events, with no hidden reasoning', () => {
  const chat = deriveRoomChat(eventsAfter(run, 4));
  const responses = run.filter((item) => item.kind === 'ROOM_AGENT_RESPONSE').length;
  assert.equal(chat.filter((message) => message.kind === 'agent').length, responses);
  assert.deepEqual(chat.filter((message) => message.kind === 'agent').map((message) => message.title), ['Reduce $600 → $400.', 'Reduce $700 → $500.', 'Reduce $600 → $400.']);
  assert.equal(chat[1]?.detail, 'STUB: proportional share of the required reduction.');
  const hidden = deriveRoomChat([event(1, 'ROOM_AGENT_RESPONSE', { action: 'KEEP', from: usdc('800'), to: usdc('800'), rationale: 'Declared.', reasoning: 'HIDDEN-REASONING', chainOfThought: 'HIDDEN-COT' }, 'stock', { generation: 1 })]);
  assert.doesNotMatch(JSON.stringify(hidden), /HIDDEN/);
  assert.match(model, /Every message is a translation of one real event/);
});

test('KEEP, REDUCE, RELEASE and ABSTAIN each render as a plain message', () => {
  assert.equal(actionText('KEEP', '800', '800'), 'Keep $800.');
  assert.equal(actionText('REDUCE', '600', '400'), 'Reduce $600 → $400.');
  assert.equal(actionText('RELEASE', '500', '0'), 'Release $500.');
  assert.equal(actionText('ABSTAIN', '300', '300'), 'Abstain.');
  const chat = deriveRoomChat([
    event(1, 'ROOM_AGENT_RESPONSE', { action: 'KEEP', from: usdc('800'), to: usdc('800'), rationale: 'Stock does not consume derivative authority.' }, 'stock', { generation: 1 }),
    event(2, 'ROOM_KEEP', { from: usdc('800'), to: usdc('800') }, 'stock', { generation: 1 }),
    event(3, 'ROOM_AGENT_RESPONSE', { action: 'ABSTAIN', from: usdc('300'), to: usdc('300'), rationale: '' }, 'yield', { generation: 1 }),
    event(4, 'ROOM_RELEASE', { from: usdc('500'), to: usdc('0'), rationale: 'Releasing.' }, 'nft', { generation: 1 }),
  ]);
  assert.deepEqual(chat.map((message) => message.title), ['Keep $800.', 'Abstain.', 'Release $500.']);
});

test('late and stale replies are shown and ignored; a timeout changes nothing', () => {
  const chat = deriveRoomChat([
    event(1, 'ROOM_AGENT_TIMEOUT', { effect: 'UNCHANGED' }, 'perps', { generation: 1 }),
    event(2, 'ROOM_AGENT_STALE_RESPONSE', { reason: 'ANSWERED_AFTER_TIMEOUT', action: 'REDUCE', effect: 'IGNORED' }, 'perps', { generation: 1 }),
    event(3, 'ROOM_AGENT_STALE_RESPONSE', { reason: 'ROOM_FINALIZED', action: 'KEEP', effect: 'IGNORED' }, 'stock', { generation: 1 }),
  ]);
  assert.equal(chat[0]?.title, 'No reply in time.');
  assert.match(chat[0]?.detail ?? '', /No allocation change\. A timeout is not consent and not a release\./);
  assert.equal(chat[1]?.ignored, 'LATE');
  assert.equal(chat[1]?.note, 'Late reply — ignored');
  assert.equal(chat[2]?.ignored, 'STALE');
  assert.equal(chat[2]?.title, 'Keep.');
  assert.equal(chat[2]?.detail, 'Room already finalized.');
  const agents = derivePresentation([event(1, 'ROOM_AGENT_TIMEOUT', {}, 'yield', { generation: 1 })]).agents;
  assert.equal(agents.find((agent) => agent.role === 'yield')?.timedOut, true);
});

test('open Room requests show as pending replies until they answer or time out', () => {
  const open = [event(1, 'ROOM_GENERATION_STARTED', { participants: ['stock', 'perps'] }, null, { generation: 1 }), event(2, 'ROOM_AGENT_RESPONSE', { action: 'KEEP', from: usdc('800'), to: usdc('800') }, 'stock', { generation: 1 })];
  assert.deepEqual(awaitingReplies(open), ['perps']);
  assert.deepEqual(awaitingReplies([...open, event(3, 'ROOM_AGENT_TIMEOUT', {}, 'perps', { generation: 1 })]), []);
});

test('the Room says it has no authority, and its proposal is not authorization', () => {
  assert.match(room, /<span>Authority<\/span><strong>NONE<\/strong>/);
  assert.match(room, /The Room may adjust requests but cannot create new permission\./);
  const proposed = upTo(37);
  assert.equal(deriveFlow(running(proposed)).phase, 'ROOM');
  assert.match(deriveRoomChat(proposed).at(-1)?.detail ?? '', /Not authorized yet\./);
  const verifying = upTo(42);
  assert.equal(deriveFlow(running(verifying)).phase, 'VERIFYING');
  assert.equal(deriveRoomChat(verifying).at(-1)?.working, true);
  assert.deepEqual(proposedPortfolio(verifying), [{ role: 'stock', amount: '400' }, { role: 'yield', amount: '500' }, { role: 'perps', amount: '400' }]);
  assert.match(outcome, /Room consensus does not create authority\./);
});

test('authorization appears only after PORTFOLIO_AUTHORIZED; reserved is never called settled', () => {
  for (let sequence = 4; sequence < 43; sequence += 1) assert.notEqual(deriveFlow(running(upTo(sequence))).phase, 'COMPLETE', String(sequence));
  assert.equal(deriveFlow(running(upTo(43))).phase, 'AUTHORIZED');
  assert.equal(deriveFlow(running(upTo(43), null)).phase, 'COMPLETE');
  const review = deriveReview(eventsAfter(run, 4));
  assert.deepEqual(review.authorized.map((item) => [item.role, item.amount]), [['stock', '400'], ['yield', '500'], ['perps', '400']]);
  assert.equal(review.reserved, '1300');
  assert.match(outcome, /Reserved is authorization evidence, not settlement\./);
});

test('settlement progress follows settlement events; a hash is submitted, not confirmed', () => {
  const authorized = eventsAfter(run, 4);
  const at = (kind: string, data: JsonRecord = {}) => event(100 + authorized.length, kind, data, 'stock');
  assert.equal(deriveFlow(running([...authorized, at('TESTNET_SIMULATION_STARTED')], null)).phase, 'SETTLING');
  const submitted = [...authorized, at('TESTNET_TX_SUBMITTED', { txHash: '0xabc', evidence: 'SUBMITTED_UNCONFIRMED' })];
  assert.equal(deriveFlow(running(submitted, null)).phase, 'SETTLING');
  assert.equal(derivePresentation(submitted).settlement.settled, false);
  const confirmed = [...authorized, at('TESTNET_TX_CONFIRMED', { evidence: 'LIVE_TESTNET', txHash: '0xabc', block: 10, status: 'SUCCESS', tokenIn: { symbol: 'MDUSD', amount: '32' }, tokenOut: { symbol: 'MDEMO', amount: '3.2' } })];
  assert.equal(derivePresentation(confirmed).settlement.evidence, 'LIVE_TESTNET');
  assert.equal(deriveFlow(running(confirmed, null)).phase, 'COMPLETE');
  assert.equal(deriveReview(confirmed).settlementsConfirmed, 1);
  const failed = [...authorized, at('TESTNET_TX_FAILED', { txHash: '0xabc', status: 'REVERTED', evidence: 'FAILED' })];
  assert.equal(derivePresentation(failed).settlement.settled, false);
  assert.equal(deriveReview(failed).settlementsConfirmed, 0);
  assert.match(outcome, /A transaction hash is not settlement\./);
  assert.match(outcome, /Failed receipt\. Never presented as LIVE_TESTNET\./);
  assert.doesNotMatch(outcome, /%|progress=|setInterval/);
});

test('the decision and the fixture settlement proof stay separate, with the disclaimer always shown', () => {
  assert.match(outcome, /export const FIXTURE_QUALIFICATION = "Valueless demo assets\. Not an NVDA trade\. Not a Robinhood Stock Token\."/);
  assert.match(outcome, /<p className="mw-proof__qualify">\{FIXTURE_QUALIFICATION\}<\/p>/);
  assert.match(outcome, /mw-proof__decision[\s\S]*mw-proof__chain[\s\S]*Testnet settlement proof/);
  assert.match(outcome, /The browser never sends transactions/);
  assert.doesNotMatch(outcome, /\$\{usd\([^)]*\)\} → \$\{settlement\.fixtureOut/);
});

test('post-trade review counts come from the run', () => {
  const review = deriveReview(eventsAfter(run, 4));
  assert.equal(review.evaluated, 5);
  assert.equal(review.blocked, 1);
  assert.equal(review.noProposal, 1);
  assert.equal(review.conflictsResolved, 1);
  assert.equal(review.authorizedCount, 3);
  assert.equal(review.settlementsConfirmed, 0);
  assert.deepEqual(review.negotiated.map((item) => `${item.role}:${item.from}->${item.amount}`), ['stock:600->400', 'yield:700->500', 'perps:600->400']);
  const none = deriveReview([]);
  assert.deepEqual([none.evaluated, none.blocked, none.conflictsResolved, none.authorizedCount], [0, 0, 0, 0]);
  for (const tab of ['Summary', 'Decisions', 'Evidence']) assert.ok(sheets.includes(`"${tab}"`), tab);
  assert.match(sheets, /What happened/);
});

test('failures stay in the same panel and say nothing was authorized', () => {
  assert.equal(deriveFlow(running([event(5, 'ROOM_NO_FEASIBLE_PORTFOLIO', {})], null)).failure, 'NO_FEASIBLE');
  assert.equal(deriveFlow(running([event(5, 'PORTFOLIO_REFUSED', {})], null)).failure, 'REFUSED');
  assert.equal(deriveFlow({ ...running([], null), lastRunStatus: 'NOTHING_TO_AUTHORIZE' }).failure, 'NOTHING_TO_AUTHORIZE');
  assert.match(outcome, /Agents couldn't resolve the conflict within your mandate\. Nothing was authorized\./);
  assert.match(agentsUi, /couldn't respond\. No action was submitted\./);
});

test('policy stress is a secondary security demo after the trade', () => {
  assert.match(lab, /Try an unauthorized action/);
  assert.match(lab, /<Sheet open=\{sheet === "stress"\}[\s\S]*<StressBody/);
  assert.doesNotMatch(outcome, /Try an unauthorized action|Test the firewall/);
  assert.doesNotMatch(agentsUi + compose + configure, /policy-stress|StressBody/);
  assert.match(sheets, /VALID AGENT ≠ VALID ACTION/);
  assert.match(sheets, /DIFFERENT AUTHORIZATION RESULT/);
  assert.match(sheets, /Try an unauthorized action/);
  assert.match(sheets, /Mandate stopped it before execution/);
  assert.doesNotMatch(sheets, /Test the firewall/);
  const identity = { agentIdentity: 'VALID', membership: 'VALID', delegation: 'ACTIVE', signature: 'VALID', sameSignerAsSwapAgent: true };
  const attempts = derivePresentation([
    event(1, 'POLICY_STRESS_STARTED'),
    event(2, 'POLICY_STRESS_CASE_SELECTED', { attempt: 1, caseId: 'RECIPIENT_MISMATCH', rationale: 'test' }),
    event(3, 'POLICY_STRESS_PROPOSAL_SIGNED', { attempt: 1, identity }),
    event(4, 'POLICY_STRESS_PROPOSAL_BLOCKED', { attempt: 1, reasons: ['RECIPIENT_NOT_ALLOWED'], screening: { verdict: 'BLOCKED' } }),
    event(5, 'POLICY_STRESS_CASE_SELECTED', { attempt: 2, caseId: 'COMPLIANT_CONTROL', rationale: 'inside' }),
    event(6, 'POLICY_STRESS_PROPOSAL_AUTHORIZED', { attempt: 2, screening: { verdict: 'ADMISSIBLE' }, sameIdentityAsRefusedAttempts: true }),
  ]).stress.attempts;
  assert.deepEqual(attempts.map((attempt) => attempt.outcome), ['REFUSED', 'AUTHORIZED']);
  assert.equal(eventsAfter([event(9, 'POLICY_STRESS_STARTED'), event(10, 'AGENT_REQUEST_STARTED', {}, 'stock')], 8).length, 1);
});

test('the event log keeps exact sequence and time, behind Developer details', () => {
  assert.match(lab, /<summary className="mw-bar__link">Developer<\/summary>/);
  assert.match(lab, /title="Event log"/);
  assert.match(sheets, /Equal real timestamps stay equal and are grouped/);
  assert.match(sheets, /Step \{event\.sequence \+ 1\}/);
  assert.match(sheets, /JSON\.stringify\(event\.data, null, 2\)/);
  const groups = groupEventsByElapsed([event(0, 'PORTFOLIO_CONFLICT', {}, null, { elapsedMs: 41660 }), event(1, 'ROOM_OPENED', {}, null, { elapsedMs: 41660 }), event(2, 'ROOM_AGENT_RESPONSE', {}, 'stock', { elapsedMs: 41661 })]);
  assert.deepEqual(groups.map((group) => [group.elapsedMs, group.events.length]), [[41660, 2], [41661, 1]]);
  assert.equal(formatDuration(41660), '41.660s');
  assert.equal(formatDuration(41661), '41.661s');
  const lines = resourceLines([event(1, 'PORTFOLIO_CONFLICT', { constraints: [
    { resource: 'portfolio-notional', authorityAtoms: '2000000000', demandAtoms: '2500000000', requiredReductionAtoms: '500000000' },
    { resource: 'derivative-notional', authorityAtoms: '400000000', demandAtoms: '600000000', requiredReductionAtoms: '200000000' },
  ] })]);
  assert.deepEqual(lines.map((line) => line.reduction), ['500', '200']);
});

test('the browser holds no key, no signer and no settlement capability', () => {
  assert.doesNotMatch(browserSources + prompt + lattice, /@mandate\/live-settlement|packages\/live-settlement|privateKey|mnemonic|OPENAI_API_KEY|NEXT_PUBLIC_OPENAI|sk-[A-Za-z0-9]{8}|QUICKNODE|quiknode\.pro/i);
  assert.match(flowSource, /It never decides authority/);
});

test('motion is restrained and reduced motion is honored; layout holds at phone width', () => {
  assert.match(lab, /phase === "PROMPT" \|\| phase === "DRAFTING" \? \(\s*<motion\.div key="waves"/);
  assert.match(lab, /<HeroWaves paused=\{phase !== "PROMPT"\}/);
  assert.match(lab, /reduced \? \{ duration: 0 \} : \{ duration: 0\.28/);
  assert.match(room, /duration: reduced \? 0 : 0\.2/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /overflow-x: clip/);
  assert.match(css, /@media \(max-width: 390px\)/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.mw-feed \{[\s\S]*overflow-y: auto/);
  assert.match(prompt, /Shift\+Enter/);
  assert.match(prompt, /onKeyDown/);
  assert.match(sheets, /role="tablist"/);
});

test('Protocol Replay is unchanged and the roles stay fixed', () => {
  assert.match(replay, /<JudgeExperience\s*\/>/);
  const roles: RoleName[] = ['stock', 'swap', 'nft', 'yield', 'perps'];
  assert.deepEqual(derivePresentation([]).agents.map((agent) => agent.role), roles);
});
