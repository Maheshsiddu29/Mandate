/**
 * `npm run portfolio:benchmark` — the cost of offchain coordination.
 *
 * Three scenarios over the demonstration's markets, each repeated on fresh
 * in-memory ledgers:
 *
 * 1. 5 agents / 10 proposals — the demonstration itself;
 * 2. 5 agents / 50 proposals — every agent proposing every round, ten rounds;
 * 3. malicious-heavy — 50 proposals, 80 % hostile: look-alikes, unknown
 *    venues, substituted recipients, over-limit requests, excess leverage and
 *    forged signatures.
 *
 * Reported per scenario: Mandate Room latency and Portfolio Verifier latency
 * (both pure), end-to-end latency (room, verifier, ledger reservation of every
 * verified child, fixture issuance), receipt encoding + digest latency,
 * transactions sent (always 0 offline) and the onchain actions a live run of
 * the verified children would need. Measurement only: nothing here is
 * committed, and no number is a claim about another machine.
 */

import { performance } from 'node:perf_hooks';
import {
  agentPolicyOf,
  compilePortfolio,
  createPortfolioCore,
  defaultExecutor,
  encodeReceipt,
  fullAvailability,
  portfolioMandateDigest,
  proposalDigest,
  proposalSigningHash,
  receiptDigest,
  registerPortfolio,
  resolveCandidate,
  resourceVectorInputOf,
  runMandateRoom,
  runPortfolio,
  validateActionCandidate,
  validateAgentProposal,
  verifyPortfolio,
  type ActionCandidateInput,
  type AgentMessage,
  type AgentPolicy,
  type AgentStrategy,
  type RoomFeedback,
  type SignedProposal,
} from '../src/index.ts';
import {
  APPROVED_POOL,
  APPROVED_ROUTER,
  APPROVED_VAULT,
  BTC_PERP,
  BTC_PRICE_LIGHTER,
  DEMO_NOW,
  DEMO_T0,
  FIXTURE_USDC,
  GENESIS_COLLECTION,
  MARKETPLACE,
  PERP_ACCOUNT,
  PRINCIPAL_ON_ARBITRUM,
  PRINCIPAL_ON_ROBINHOOD,
  STOCK_APPROVED,
  STOCK_LOOKALIKE,
  UNKNOWN_ROUTER,
  WETH,
  demoAgentStrategies,
  demoBindings,
  demoKey,
  demoMandate,
  demoParty,
  demoPrincipalSignature,
  signPrehash,
} from '../src/demo/index.ts';

const m = demoMandate();
const bindings = demoBindings();
const signature = demoPrincipalSignature();
const digest = portfolioMandateDigest(m);
const NONE = { ticker: null, displayName: null, issuer: null, asset: null };
const usdc = (n: bigint) => n * 1_000_000n;
const QUOTED = DEMO_NOW - 10n;

/** A signed proposal for `role`, declaring the demand the public binding code derives (nothing, if it cannot resolve). */
function signed(role: string, input: ActionCandidateInput, sequence: bigint, signer = role): SignedProposal {
  const c = validateActionCandidate(input);
  if (!c.ok) throw new Error(c.error.code);
  const r = resolveCandidate(bindings, m, agentPolicyOf(m, demoParty(role)) as AgentPolicy, c.value, DEMO_NOW);
  const requested = r.ok ? resourceVectorInputOf(r.action.demand) : [];
  const p = validateAgentProposal({ portfolioMandate: digest, agent: demoParty(role), sequence, candidate: input, requested, minimum: [], utilityBps: 0n, createdAt: DEMO_NOW - 10n, expiresAt: DEMO_NOW + 3_600n, criticalExtensions: [] });
  if (!p.ok) throw new Error(p.error.code);
  return { proposal: p.value, signature: signPrehash(proposalSigningHash(proposalDigest(p.value)), demoKey(signer)) };
}

const honest: { readonly [role: string]: (i: bigint) => ActionCandidateInput } = {
  stock: (i) => ({ kind: 'STOCK_BUY', representation: STOCK_APPROVED, account: PRINCIPAL_ON_ROBINHOOD, quantity: 10n ** 17n * (1n + (i % 3n)), claims: NONE }),
  swap: (i) => ({ kind: 'SWAP_EXACT_IN', router: APPROVED_ROUTER, route: [APPROVED_POOL], tokenIn: FIXTURE_USDC, tokenOut: WETH, amountIn: usdc(5n + i), quotedOut: usdc(5n + i) * 120_000n, minOut: usdc(5n + i) * 119_700n, quoteObservedAt: QUOTED, recipient: PRINCIPAL_ON_ARBITRUM, claims: NONE }),
  nft: (i) => ({ kind: 'NFT_BUY', marketplace: MARKETPLACE, collection: GENESIS_COLLECTION, tokenId: i, maxPrice: usdc(5n + i), recipient: PRINCIPAL_ON_ARBITRUM, claims: NONE }),
  yield: (i) => ({ kind: 'YIELD_DEPOSIT', product: APPROVED_VAULT, amount: usdc(5n + i), quotedApyBps: 520, quoteObservedAt: QUOTED, recipient: PRINCIPAL_ON_ARBITRUM, claims: NONE }),
  perps: (i) => ({ kind: 'PERP_OPEN', market: BTC_PERP, account: PERP_ACCOUNT, side: 'LONG', size: 20n + i, price: BTC_PRICE_LIGHTER, initialMarginFraction: 5_000, claims: NONE }),
};

const variant = (role: string, patch: object) => (i: bigint): ActionCandidateInput => ({ ...(honest[role] as (i: bigint) => ActionCandidateInput)(i), ...patch }) as ActionCandidateInput;

const hostile: { readonly [role: string]: (i: bigint) => ActionCandidateInput } = {
  stock: (i) => ({ kind: 'STOCK_BUY', representation: STOCK_LOOKALIKE, account: PRINCIPAL_ON_ROBINHOOD, quantity: 10n ** 18n + i, claims: { ...NONE, ticker: 'NVDA' } }),
  swap: variant('swap', { router: UNKNOWN_ROUTER }),
  nft: variant('nft', { recipient: 'eip155:421614/account:0x9999999999999999999999999999999999999999' }),
  yield: variant('yield', { amount: usdc(900n) }),
  perps: variant('perps', { initialMarginFraction: 1_000 }),
};

/** One prepared message per round. */
class Prepared implements AgentStrategy {
  readonly agent: { kind: string; value: string };
  readonly #messages: readonly AgentMessage[];
  constructor(role: string, messages: readonly AgentMessage[]) {
    this.agent = demoParty(role);
    this.#messages = messages;
  }
  act(round: number, _feedback: RoomFeedback): AgentMessage {
    return this.#messages[round - 1] ?? { kind: 'IDLE' };
  }
}

function scenario(perAgent: number, hostileShare: number): () => AgentStrategy[] {
  const prepared = ['stock', 'swap', 'nft', 'yield', 'perps'].map((role, k) => {
    const messages: AgentMessage[] = [];
    for (let i = 0; i < perAgent; i += 1) {
      const bad = (i * 5 + k) % 10 < hostileShare * 10;
      const forged = bad && i % 5 === 4;
      const input = (bad ? hostile : honest)[role] as (i: bigint) => ActionCandidateInput;
      messages.push({ kind: 'PROPOSE', signed: signed(role, input(BigInt(i)), BigInt(i + 1), forged ? 'outsider' : role) });
    }
    return [role, messages] as const;
  });
  return () => prepared.map(([role, messages]) => new Prepared(role, messages));
}

function stats(xs: readonly number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s[Math.min(s.length - 1, Math.floor(p * s.length))] as number).toFixed(2);
  return `median ${q(0.5)} ms · p95 ${q(0.95)} ms`;
}

async function registered() {
  const compiled = compilePortfolio(m, bindings);
  if (!compiled.ok) throw new Error('compile');
  const core = createPortfolioCore(compiled.value);
  const r = await registerPortfolio(core, DEMO_T0);
  if (!r.ok) throw new Error('register');
  return core;
}

async function measure(name: string, agents: () => AgentStrategy[], runs: number): Promise<void> {
  const room: number[] = [];
  const verify: number[] = [];
  const endToEnd: number[] = [];
  const receipt: number[] = [];
  let proposals = 0;
  let refusals = 0;
  let children = 0;
  let live = 0;
  let transactions = 0;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    const o = runMandateRoom({ mandate: m, signature, bindings, availability: fullAvailability(m), now: DEMO_NOW, agents: agents(), maxRounds: 10 });
    const t1 = performance.now();
    const v = verifyPortfolio({ mandate: m, signature, bindings, availability: fullAvailability(m), now: DEMO_NOW, candidate: o.candidate, proposals: o.proposals, releases: o.signedReleases });
    const t2 = performance.now();
    room.push(t1 - t0);
    verify.push(t2 - t1);
    if (v.status !== 'VERIFIED') throw new Error(`${name}: verification refused ${v.reasons.map((r) => r.code).join(',')}`);
    proposals = o.proposals.length;
    refusals = o.decisions.filter((d) => d.outcome !== 'ACCEPTED').length;
    children = v.children.length;
    live = v.children.filter((c) => c.candidate.kind === 'STOCK_BUY' || c.candidate.kind === 'PERP_OPEN').length;

    const core = await registered();
    const t3 = performance.now();
    const full = await runPortfolio({ core, signature, now: DEMO_NOW, agents: agents(), execute: defaultExecutor(core), maxRounds: 10 });
    const t4 = performance.now();
    encodeReceipt(full.receipt);
    receiptDigest(full.receipt);
    const t5 = performance.now();
    endToEnd.push(t4 - t3);
    receipt.push(t5 - t4);
    transactions += full.receipt.transactions;
  }
  process.stdout.write(
    [
      name,
      `  proposals ${proposals} · offchain refusals ${refusals} (0 transactions, 0 gas) · verified children ${children}`,
      `  Mandate Room           ${stats(room)}`,
      `  Portfolio Verifier     ${stats(verify)}`,
      `  end to end             ${stats(endToEnd)}  (room, verifier, ledger reservation of every child, fixture issuance)`,
      `  receipt encode+digest  ${stats(receipt)}`,
      `  transactions sent ${transactions} · onchain actions a live run would need: ${live} (stock and perps children; fixture domains have no live counterpart)`,
      '',
    ].join('\n'),
  );
}

const RUNS = 20;
process.stdout.write(`portfolio benchmark — ${RUNS} runs per scenario, Node ${process.version}, ${process.platform}/${process.arch}\n\n`);
await measure('5 agents / 10 proposals (the demonstration)', () => [...demoAgentStrategies(m, bindings, DEMO_NOW)], RUNS);
await measure('5 agents / 50 proposals', scenario(10, 0), RUNS);
await measure('malicious-heavy: 50 proposals, 80 % hostile', scenario(10, 0.8), RUNS);
