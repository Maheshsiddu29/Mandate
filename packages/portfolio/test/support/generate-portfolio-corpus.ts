/**
 * Generates `corpus/portfolio-demo-v1/`: the demonstration's canonical
 * mandate, its receipt, its UI view, and screening vectors — every proposal
 * shape the demonstration's agents and the security tests use, with the
 * outcome and reason codes the screen assigns it. A second implementation of
 * the portfolio layer must reproduce every digest and every vector.
 *
 * A new, versioned corpus: no earlier corpus is touched.
 *
 * Run: `npm run portfolio-corpus:generate`. Offline and deterministic.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex } from '@mandate/core';
import {
  agentProposalInputOf,
  encodePortfolioMandate,
  portfolioMandateDigest,
  portfolioView,
  proposalDigest,
  proposalSigningHash,
  screenProposal,
  validateAgentProposal,
  type ActionCandidate,
  type SignedProposal,
} from '../../src/index.ts';
import {
  IMPOSTOR_COLLECTION,
  STOCK_COUNTERFEIT,
  STOCK_LOOKALIKE,
  UNKNOWN_ROUTER,
  UNVETTED_VAULT,
  USDC,
  demoBindings,
  demoKey,
  demoMandate,
  demoParty,
  runDemo,
  signPrehash,
} from '../../src/demo/index.ts';
import { NOW, nftBuy, perpOpen, stockBuy, swap, yieldDeposit } from './candidates.ts';
import { proposal } from './world.ts';

export const PORTFOLIO_CORPUS_DIR = fileURLToPath(new URL('../../../../corpus/portfolio-demo-v1/', import.meta.url));
export const PORTFOLIO_CORPUS_VERSION = 1;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Canonical JSON for a corpus: bigints as decimal strings, bytes as hex, maps as sorted objects. */
export function toJson(v: unknown): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Uint8Array) return bytesToHex(v);
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), toJson(x)]).sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1)));
  if (v instanceof Set) return [...v].map(toJson);
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, toJson(x)]));
  return null;
}

const text = (j: Json) => `${JSON.stringify(j, null, 2)}\n`;

const m = demoMandate();
const resign = (p: SignedProposal['proposal'], role: string): SignedProposal => ({ proposal: p, signature: signPrehash(proposalSigningHash(proposalDigest(p)), demoKey(role)) });
const variant = (base: SignedProposal, patch: object, role: string): SignedProposal => {
  const v = validateAgentProposal({ ...agentProposalInputOf(base.proposal), ...patch });
  if (!v.ok) throw new Error(`vector proposal refused: ${v.error.code}`);
  return resign(v.value, role);
};

/** Every vector: an id, the agent, and the signed proposal it screens. */
function vectors(): readonly { id: string; role: string; signed: SignedProposal }[] {
  const p = (role: string, c: ActionCandidate, o: Parameters<typeof proposal>[3] = {}) => proposal(m, role, c, o);
  const thief = 'eip155:421614/account:0x9999999999999999999999999999999999999999';
  const swapBase = p('swap', swap());
  return [
    { id: 'stock/approved', role: 'stock', signed: p('stock', stockBuy({ tenths: 40n })) },
    { id: 'stock/same-ticker-lookalike', role: 'stock', signed: p('stock', stockBuy({ representation: STOCK_LOOKALIKE })) },
    { id: 'stock/unregistered-counterfeit', role: 'stock', signed: p('stock', stockBuy({ representation: STOCK_COUNTERFEIT })) },
    { id: 'stock/false-issuer-claim', role: 'stock', signed: p('stock', stockBuy({ claims: { issuer: 'issuer.fixture.omega' } })) },
    { id: 'stock/other-recipient', role: 'stock', signed: p('stock', stockBuy({ account: 'eip155:46630/account:0x9999999999999999999999999999999999999999' })) },
    { id: 'stock/beyond-hard-maximum', role: 'stock', signed: p('stock', stockBuy({ tenths: 65n }), { minimum: false }) },
    { id: 'swap/approved', role: 'swap', signed: swapBase },
    { id: 'swap/unknown-router', role: 'swap', signed: p('swap', swap({ router: UNKNOWN_ROUTER, quotedOut: 125_000_000_000_000_000n })) },
    { id: 'swap/unreviewed-pool', role: 'swap', signed: p('swap', swap({ route: ['eip155:421614/pool:0x000000000000000000000000000000000000dead'] })) },
    { id: 'swap/recipient-substituted', role: 'swap', signed: p('swap', swap({ recipient: thief })) },
    { id: 'swap/slippage', role: 'swap', signed: p('swap', swap({ minOut: 119_000_000_000_000_000n })) },
    { id: 'swap/stale-quote', role: 'swap', signed: p('swap', swap({ observedAt: NOW - 61n })) },
    { id: 'swap/foreign-funding-token', role: 'swap', signed: p('swap', swap({ tokenIn: 'eip155:421614/erc20:0x0000000000000000000000000000000000000bad' })) },
    { id: 'nft/genuine', role: 'nft', signed: p('nft', nftBuy({ price: USDC(250n) })) },
    { id: 'nft/same-name-impostor', role: 'nft', signed: p('nft', nftBuy({ collection: IMPOSTOR_COLLECTION })) },
    { id: 'nft/unreviewed-contract', role: 'nft', signed: p('nft', nftBuy({ collection: 'eip155:421614/erc721:0x0000000000000000000000000000000000000077' })) },
    { id: 'yield/approved-5.20', role: 'yield', signed: p('yield', yieldDeposit({ amount: USDC(500n) })) },
    { id: 'yield/unvetted-12.60', role: 'yield', signed: p('yield', yieldDeposit({ product: UNVETTED_VAULT, apyBps: 1_260 })) },
    { id: 'yield/stale-quote', role: 'yield', signed: p('yield', yieldDeposit({ observedAt: NOW - 301n })) },
    { id: 'perps/400-at-2x', role: 'perps', signed: p('perps', perpOpen({ usdc: 400n })) },
    { id: 'perps/600-over-derivative-exposure', role: 'perps', signed: p('perps', perpOpen({ usdc: 600n }), { minimum: false }) },
    { id: 'perps/5x-leverage', role: 'perps', signed: p('perps', perpOpen({ usdc: 400n, imf: 2_000 })) },
    { id: 'perps/unclaimed-market', role: 'perps', signed: p('perps', perpOpen({ market: 'lighter:300/perp:9999' })) },
    { id: 'auth/outsider', role: 'outsider', signed: resign(variant(swapBase, { agent: demoParty('outsider') }, 'outsider').proposal, 'outsider') },
    { id: 'auth/signed-by-another-agent', role: 'swap', signed: { proposal: swapBase.proposal, signature: resign(swapBase.proposal, 'stock').signature } },
    { id: 'auth/other-mandate', role: 'swap', signed: proposal(demoMandate({ nonce: 2n }), 'swap', swap()) },
    { id: 'form/unknown-critical-extension', role: 'swap', signed: variant(swapBase, { criticalExtensions: ['mev-protection'] }, 'swap') },
    { id: 'form/understated-demand', role: 'swap', signed: variant(swapBase, { requested: [{ resource: 'portfolio-notional', atoms: 1n }], minimum: [] }, 'swap') },
    { id: 'form/minimum-above-request', role: 'swap', signed: variant(swapBase, { minimum: [{ resource: 'portfolio-notional', atoms: USDC(301n) }] }, 'swap') },
    { id: 'time/expired-proposal', role: 'swap', signed: p('swap', swap(), { expiresAt: NOW }) },
  ];
}

export async function serializeCorpus(): Promise<{ readonly [file: string]: string }> {
  const run = await runDemo();
  const view = portfolioView(run.core, run);
  const bindings = demoBindings();
  const screened = vectors().map(({ id, role, signed }) => {
    const s = screenProposal(m, bindings, signed, NOW);
    return {
      id,
      agent: role,
      proposal: proposalDigest(signed.proposal),
      outcome: s.child !== null ? 'PASS' : s.quantityOnly ? 'REDUCE' : 'REFUSED',
      reasons: s.reasons.map((r) => ({ code: r.code, subject: r.subject })),
      registry: s.registry === null ? null : { status: s.registry.status, codes: s.registry.codes },
      child: s.child === null ? null : { approved: s.child.approved },
    };
  });
  return {
    'mandate.json': text(toJson({ corpusVersion: PORTFOLIO_CORPUS_VERSION, schema: 'PORTFOLIO_MANDATE.V1', digest: portfolioMandateDigest(m), encoding: bytesToHex(encodePortfolioMandate(m)), principalSignature: run.signature })),
    'receipt.json': text(toJson({ corpusVersion: PORTFOLIO_CORPUS_VERSION, schema: 'PORTFOLIO_RECEIPT.V1', receiptDigest: run.digest, receipt: run.receipt })),
    'view.json': text(toJson({ corpusVersion: PORTFOLIO_CORPUS_VERSION, view })),
    'vectors.json': text(toJson({ corpusVersion: PORTFOLIO_CORPUS_VERSION, evaluatedAt: NOW, vectorCount: screened.length, vectors: screened })),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await serializeCorpus();
  mkdirSync(PORTFOLIO_CORPUS_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(PORTFOLIO_CORPUS_DIR, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  process.stdout.write(`wrote ${Object.keys(files).length} files to ${PORTFOLIO_CORPUS_DIR}\n`);
}
