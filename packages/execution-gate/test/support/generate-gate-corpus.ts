/**
 * Execution-gate differential corpus generator (`corpus/gate-v1`).
 *
 * Every expected value here is computed by the TypeScript side — the kernel's
 * encoder, decoder and signature rule, plus the reference model in
 * `src/model.ts`. `contracts/test/Differential.t.sol` replays every vector
 * against the Solidity gate and asserts identical results: digests, execution
 * commitments, settled amounts, and exact revert data for every refusal.
 *
 * Three parts:
 *
 * - `vectors`: complete `execute` attempts in the fixed world of `world.ts`.
 *   Hand-written families first, then seeded mutations of the base attempts.
 * - `mandateEncodings` / `candidateEncodings`: every parseable mandate and
 *   candidate in `corpus/v2` and `corpus/mainnet-v1` (recorded Robinhood mainnet
 *   state), whose digests come from the *kernel's* encoder; plus seeded
 *   structural mutations whose validity comes from the kernel's *decoder*.
 *
 * Nothing is typed twice: inputs are generated once and emitted both readably
 * and as the ABI blobs the Solidity harness decodes.
 *
 * Run: `npm run gate-corpus:generate`. `corpus.test.ts` fails if the committed
 * file differs from what this produces.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { candidateDigest, mandateDigest, parseCandidate, parseMandate } from '@mandate/kernel';
import {
  UINT256_MAX,
  caip2,
  decodeGateCandidate,
  decodeGateMandate,
  gateDomain,
  representationIdFor,
  toGateCandidate,
  toGateMandate,
  type GateAttempt,
  type GateCandidate,
  type GateMandate,
} from '../../src/index.ts';
import { abiEncode, address, array, bool, bytes, bytes32, CANDIDATE, MANDATE, string, TERMS, tuple, uint } from './abi.ts';
import {
  ADDR,
  AGENT_KEY,
  CHAIN_ID,
  DOMAIN,
  NVDA,
  STRANGER,
  STRANGER_KEY,
  ScriptMode,
  T0,
  baseBuy,
  baseCandidate,
  baseSell,
  defaultSetup,
  honest,
  now,
  sign,
  simulate,
  type ChainMoment,
  type Expected,
  type Script,
  type SimAttempt,
  type TokenSetup,
  type Unsigned,
} from './world.ts';

export const GATE_CORPUS_VERSION = 1;
export const SEEDED_VECTOR_COUNT = 120;
export const SEEDED_VALIDATION_COUNT = 120;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// --- Vector specs -------------------------------------------------------------

interface AttemptSpec {
  readonly unsigned: Unsigned;
  readonly moment?: ChainMoment;
  readonly script?: Script;
  readonly signOptions?: Parameters<typeof sign>[1];
  /** Applied after signing: tampering the signatures do not cover. */
  readonly tamper?: (a: GateAttempt) => GateAttempt;
}

interface VectorSpec {
  readonly id: string;
  readonly family: string;
  readonly description: string;
  readonly setup?: (s: TokenSetup[]) => TokenSetup[];
  readonly attempts: readonly AttemptSpec[];
}

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const QTY = 10n * E18;
/** 10 fAAPL at 200 USDC + 30 bps. */
const BUY_COST = 2_006n * E6;
const SELL_PROCEEDS = 1_994n * E6;
const BUY_REFUND = 2_010n * E6 - BUY_COST;

const buyOk = (): Script => honest(QTY, BUY_REFUND);
const sellOk = (): Script => honest(SELL_PROCEEDS);

function withMandate(u: Unsigned, patch: Partial<GateMandate>): Unsigned {
  return { ...u, mandate: { ...u.mandate, ...patch } };
}
function withCandidate(u: Unsigned, patch: Partial<GateCandidate>): Unsigned {
  return { ...u, candidate: { ...u.candidate, ...patch } };
}
function withTerms(u: Unsigned, patch: Partial<Unsigned['terms']>): Unsigned {
  return { ...u, terms: { ...u.terms, ...patch } };
}

function one(id: string, family: string, description: string, attempt: AttemptSpec, setup?: VectorSpec['setup']): VectorSpec {
  return setup === undefined ? { id, family, description, attempts: [attempt] } : { id, family, description, setup, attempts: [attempt] };
}

function hexWithByte(hex: string, index: number, value: number): string {
  const b = hex.slice(2).match(/../g) as string[];
  b[index] = value.toString(16).padStart(2, '0');
  return '0x' + b.join('');
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The high-s twin of a valid low-s signature: same key, same hash, different bytes. */
function malleate(signature: string): string {
  const s = BigInt('0x' + signature.slice(66, 130));
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return signature.slice(0, 66) + (N - s).toString(16).padStart(64, '0') + (v === 27 ? '1c' : '1b');
}

const otherGateDomain = gateDomain(CHAIN_ID, '0x000000000000000000000000000000000000beef');
const otherChainDomain = gateDomain(1n, ADDR.gate);

function handWritten(): VectorSpec[] {
  const buy = baseBuy();
  const sell = baseSell();
  const e = (u: Unsigned, extra: Omit<AttemptSpec, 'unsigned'> = {}): AttemptSpec => ({ unsigned: u, script: buyOk(), ...extra });

  return [
    // --- valid ------------------------------------------------------------------
    one('valid-buy-001', 'valid', 'BUY 10 fAAPL within a 2010 USD MAX_TOTAL_DEBIT; the adapter refunds unspent funding.', e(buy)),
    one('valid-sell-001', 'valid', 'SELL 10 fAAPL for at least 1990 USD MIN_TOTAL_CREDIT.', { unsigned: sell, script: sellOk() }),
    one('valid-buy-002', 'valid-boundary', 'fundingLimit exactly equal to the converted MAX_TOTAL_DEBIT, fully spent.', e(buy, { script: honest(QTY, 0n) })),
    one('valid-sell-002', 'valid-boundary', 'Credit exactly equal to fundingLimit, itself exactly the converted MIN_TOTAL_CREDIT.', { unsigned: sell, script: honest(1_990n * E6) }),
    one('valid-buy-003', 'valid-boundary', 'Debit exactly equal to fundingLimit and credit exactly equal to quantity.', e(withTerms(buy, { fundingLimit: BUY_COST }), { script: honest(QTY, 0n) })),
    one('valid-buy-004', 'valid', 'A mandate bound in 2-decimal USD, converted exactly to 6-decimal funding atoms.', e(withMandate(buy, { maxNotional: { unit: 'USD', decimals: 2, atoms: 200_000n }, economicLimit: { unit: 'USD', decimals: 2, atoms: 201_000n } }))),
    one('valid-buy-005', 'valid', 'An 8-decimal representation paid for with an 18-decimal funding token.', e(
      withTerms(withCandidate(buy, { representationId: representationIdFor(CHAIN_ID, ADDR.eightDecimal), venue: 'venue.other', quantity: { unit: 'TOKEN', decimals: 8, atoms: 10n * 10n ** 8n } }), { fundingLimit: 2_010n * E18 }),
      { script: honest(10n * 10n ** 8n, 4n * E18) },
    )),
    one('valid-buy-006', 'valid', 'Synthetic exposure explicitly permitted by the mandate.', e(
      withCandidate(withMandate(buy, { syntheticPolicy: 2n, allowedIssuers: ['issuer.alpha', 'issuer.synthetic'] }), { representationId: representationIdFor(CHAIN_ID, ADDR.synth), issuer: 'issuer.synthetic' }),
    )),
    one('valid-buy-007', 'valid', 'The adapter over-delivers: more output is never a violation.', e(buy, { script: honest(QTY + 1n, BUY_REFUND) })),
    one('valid-buy-008', 'valid', 'The adapter returns garbage claiming an enormous fill; the gate reads nothing it returns.', e(buy, { script: { ...buyOk(), mode: ScriptMode.RETURN_GARBAGE } })),
    one('valid-buy-009', 'valid', 'Non-empty route data, committed by the agent.', e(withTerms(buy, { executionData: '0xc0ffee' }))),

    // --- chain time -------------------------------------------------------------
    one('time-001', 'time-boundary', 'block.timestamp == notBefore: live (inclusive).', e(buy, { moment: now(T0 - 60n) })),
    one('time-002', 'time-boundary', 'block.timestamp == notBefore - 1: not yet active.', e(buy, { moment: now(T0 - 61n) })),
    one('time-003', 'time-boundary', 'block.timestamp == expiresAt - 1, deadline extended to it: live.', e(withTerms(buy, { deadline: T0 + 3_599n }), { moment: now(T0 + 3_599n) })),
    one('time-004', 'time-boundary', 'block.timestamp == expiresAt: expired (exclusive, as the kernel).', e(withTerms(buy, { deadline: T0 + 3_600n }), { moment: now(T0 + 3_600n) })),
    one('time-005', 'time-boundary', 'block.timestamp == deadline: live (inclusive).', e(buy, { moment: now(T0 + 300n) })),
    one('time-006', 'time-boundary', 'block.timestamp == deadline + 1: deadline passed.', e(buy, { moment: now(T0 + 301n) })),
    one('time-007', 'time-boundary', 'A deadline past the mandate expiry does not extend the mandate.', e(withTerms(buy, { deadline: T0 + 99_999n }), { moment: now(T0 + 3_700n) })),

    // --- domain and signatures ---------------------------------------------------
    one('chain-001', 'wrong-chain', 'Executed on a chain other than the deployment chain.', e(buy, { moment: now(T0, 1n) })),
    one('sig-001', 'principal-signature', 'Mandate signed by someone other than the principal.', e(buy, { signOptions: { principalKey: STRANGER_KEY } })),
    one('sig-002', 'cross-contract-replay', 'Principal signature made for a different gate address.', e(buy, { signOptions: { principalDomain: otherGateDomain } })),
    one('sig-003', 'cross-chain-replay', 'Principal signature made for the same gate address on another chain.', e(buy, { signOptions: { principalDomain: otherChainDomain } })),
    one('sig-004', 'signature-malleability', 'High-s twin of a valid principal signature.', e(buy, { tamper: (a) => ({ ...a, principalSignature: malleate(a.principalSignature) }) })),
    one('sig-005', 'signature-malformed', 'Principal signature with v = 0 (only 27/28 accepted).', e(buy, { tamper: (a) => ({ ...a, principalSignature: hexWithByte(a.principalSignature, 64, (Number.parseInt(a.principalSignature.slice(130), 16) - 27)) }) })),
    one('sig-006', 'signature-malformed', 'Principal signature truncated to 64 bytes.', e(buy, { tamper: (a) => ({ ...a, principalSignature: a.principalSignature.slice(0, 130) }) })),
    one('sig-007', 'signature-malformed', 'Empty principal signature.', e(buy, { tamper: (a) => ({ ...a, principalSignature: '0x' }) })),
    one('sig-008', 'agent-signature', 'Execution signed by someone other than the mandate agent.', e(buy, { signOptions: { agentKey: STRANGER_KEY } })),
    one('sig-009', 'cross-contract-replay', 'Agent signature made for a different gate address.', e(buy, { signOptions: { agentDomain: otherGateDomain } })),
    one('sig-010', 'cross-chain-replay', 'Agent signature made for another chain.', e(buy, { signOptions: { agentDomain: otherChainDomain } })),
    one('sig-011', 'signature-malleability', 'High-s twin of a valid agent signature.', e(buy, { tamper: (a) => ({ ...a, agentSignature: malleate(a.agentSignature) }) })),
    one('sig-012', 'type-confusion', 'The principal signature presented as the agent signature.', e(buy, { tamper: (a) => ({ ...a, agentSignature: a.principalSignature }) })),
    one('sig-013', 'type-confusion', 'The agent signs the MandateAuthorization instead of the execution.', e(withMandate(buy, { principal: buy.mandate.agent }), { signOptions: { principalKey: AGENT_KEY }, tamper: (a) => ({ ...a, agentSignature: a.principalSignature }) })),

    // --- transaction binding: mutation after signing -----------------------------
    one('bind-001', 'mandate-mutation', 'Economic limit raised after the principal signed.', e(buy, { tamper: (a) => ({ ...a, mandate: { ...a.mandate, economicLimit: { unit: 'USD', decimals: 18, atoms: 9_999n * E18 } } }) })),
    one('bind-002', 'mandate-mutation', 'Nonce changed after signing.', e(buy, { tamper: (a) => ({ ...a, mandate: { ...a.mandate, nonce: 2n } }) })),
    one('bind-003', 'mandate-mutation', 'Side flipped after signing.', e(buy, { tamper: (a) => ({ ...a, mandate: { ...a.mandate, side: 2n } }) })),
    one('bind-004', 'mandate-mutation', 'Expiry extended after signing.', e(buy, { tamper: (a) => ({ ...a, mandate: { ...a.mandate, expiresAtUnixSeconds: T0 + 999_999n } }) })),
    one('bind-005', 'mandate-mutation', 'Agent substituted after signing.', e(buy, { tamper: (a) => ({ ...a, mandate: { ...a.mandate, agent: STRANGER } }) })),
    one('bind-006', 'candidate-mutation', 'Token substituted after the agent signed.', e(buy, { tamper: (a) => ({ ...a, candidate: { ...a.candidate, representationId: representationIdFor(CHAIN_ID, ADDR.nvda) } }) })),
    one('bind-007', 'candidate-mutation', 'Quantity changed after the agent signed.', e(buy, { tamper: (a) => ({ ...a, candidate: { ...a.candidate, quantity: { ...a.candidate.quantity, atoms: 1n } } }) })),
    one('bind-008', 'terms-mutation', 'Recipient substituted after the agent signed.', e(buy, { tamper: (a) => ({ ...a, terms: { ...a.terms, recipient: STRANGER } }) })),
    one('bind-009', 'terms-mutation', 'Spend raised after the agent signed.', e(buy, { tamper: (a) => ({ ...a, terms: { ...a.terms, fundingLimit: a.terms.fundingLimit + 1n } }) })),
    one('bind-010', 'terms-mutation', 'Minimum proceeds lowered after the agent signed (SELL).', { unsigned: sell, script: sellOk(), tamper: (a) => ({ ...a, terms: { ...a.terms, fundingLimit: a.terms.fundingLimit - 1n } }) }),
    one('bind-011', 'terms-mutation', 'Deadline extended after the agent signed.', e(buy, { tamper: (a) => ({ ...a, terms: { ...a.terms, deadline: a.terms.deadline + 1n } }) })),
    one('bind-012', 'terms-mutation', 'Route data substituted after the agent signed.', e(buy, { tamper: (a) => ({ ...a, terms: { ...a.terms, executionData: '0x01' } }) })),

    // --- authorized-but-inconsistent: everything signed, binding refuses ---------
    one('bind-101', 'agent-binding', 'Candidate names an agent other than the mandate agent.', e(withCandidate(buy, { agent: STRANGER }))),
    one('bind-102', 'side-binding', 'SELL candidate under a BUY mandate.', e(withCandidate(buy, { side: 2n }))),
    one('bind-103', 'asset-binding', 'Candidate claims NVDA under an AAPL mandate.', e(withCandidate(buy, { canonicalAsset: NVDA }))),
    one('bind-104', 'token-substitution', 'fNVDA token presented as AAPL exposure: the pinned market asset refuses.', e(withCandidate(buy, { representationId: representationIdFor(CHAIN_ID, ADDR.nvda) }))),
    one('bind-105', 'token-substitution', 'A lookalike token that is not a supported market.', e(withCandidate(buy, { representationId: representationIdFor(CHAIN_ID, ADDR.unlisted) }))),
    one('bind-106', 'token-substitution', 'The supported token spelled with an uppercase address: not the registry identifier.', e(withCandidate(buy, { representationId: `${caip2(CHAIN_ID)}/erc20:0x000000000000000000000000000000000000AA01` }))),
    one('bind-107', 'chain-binding', 'Candidate names another chain.', e(withCandidate(buy, { chain: 'eip155:1' }))),
    one('bind-108', 'chain-binding', 'Mandate does not allow this chain.', e(withMandate(buy, { allowedChains: ['eip155:1'] }))),
    one('bind-109', 'venue-binding', 'Candidate names a venue other than the market venue.', e(withCandidate(buy, { venue: 'venue.other' }))),
    one('bind-110', 'venue-binding', 'Mandate does not allow the market venue.', e(withMandate(buy, { allowedVenues: ['venue.other'] }))),
    one('bind-111', 'issuer-binding', 'Candidate misdescribes the issuer.', e(withCandidate(buy, { issuer: 'issuer.omega' }))),
    one('bind-112', 'issuer-binding', 'Mandate does not allow the market issuer.', e(withMandate(buy, { allowedIssuers: ['issuer.omega'] }))),
    one('bind-113', 'synthetic-binding', 'Synthetic representation under a mandate that forbids synthetic exposure.', e(
      withCandidate(withMandate(buy, { allowedIssuers: ['issuer.alpha', 'issuer.synthetic'] }), { representationId: representationIdFor(CHAIN_ID, ADDR.synth), issuer: 'issuer.synthetic' }),
    )),
    one('bind-114', 'unit-binding', 'Quantity in SHARE rather than TOKEN: a share is not a token under a multiplier.', e(withCandidate(buy, { quantity: { unit: 'SHARE', decimals: 18, atoms: QTY } }))),
    one('bind-115', 'unit-binding', 'Quantity at 6 decimals for an 18-decimal token.', e(withCandidate(buy, { quantity: { unit: 'TOKEN', decimals: 6, atoms: 10n * E6 } }))),
    one('bind-116', 'unit-binding', 'Zero quantity.', e(withCandidate(buy, { quantity: { unit: 'TOKEN', decimals: 18, atoms: 0n } }))),
    one('bind-117', 'unit-binding', 'Mandate economic limit in EUR for a USD-settled market.', e(withMandate(buy, { maxNotional: { unit: 'EUR', decimals: 18, atoms: 2_000n * E18 }, economicLimit: { unit: 'EUR', decimals: 18, atoms: 2_010n * E18 } }))),
    one('bind-118', 'recipient-binding', 'Agent-signed recipient other than the principal.', e(withTerms(buy, { recipient: STRANGER }))),

    // --- economic bounds -------------------------------------------------------
    one('econ-001', 'spend-bound', 'fundingLimit one atom above the converted MAX_TOTAL_DEBIT.', e(withTerms(buy, { fundingLimit: 2_010n * E6 + 1n }))),
    one('econ-002', 'spend-bound', 'Sub-atom bound rounds down: 2010.0000009 USD permits only 2010.000000 USDC.', e(withTerms(withMandate(buy, { economicLimit: { unit: 'USD', decimals: 18, atoms: 2_010n * E18 + 900_000_000_000n } }), { fundingLimit: 2_010n * E6 + 1n }))),
    one('econ-003', 'proceeds-bound', 'SELL fundingLimit one atom below the converted MIN_TOTAL_CREDIT.', { unsigned: withTerms(sell, { fundingLimit: 1_990n * E6 - 1n }), script: sellOk() }),
    one('econ-004', 'proceeds-bound', 'Sub-atom minimum rounds up: 1989.9999991 USD requires 1990.000000 USDC.', { unsigned: withTerms(withMandate(sell, { economicLimit: { unit: 'USD', decimals: 18, atoms: 1_990n * E18 - 900_000_000_000n } }), { fundingLimit: 1_990n * E6 - 1n }), script: sellOk() }),
    one('econ-005', 'proceeds-bound', 'A MIN_TOTAL_CREDIT too large for uint256 in funding atoms: unreachable, refused.', { unsigned: withTerms(withMandate(sell, { economicLimit: { unit: 'USD', decimals: 0, atoms: UINT256_MAX } }), { fundingLimit: UINT256_MAX }), script: sellOk() }),
    one('econ-006', 'spend-bound', 'A MAX_TOTAL_DEBIT too large for uint256 saturates: any representable limit is within it.', e(withMandate(buy, { maxNotional: { unit: 'USD', decimals: 0, atoms: UINT256_MAX }, economicLimit: { unit: 'USD', decimals: 0, atoms: UINT256_MAX } }))),

    // --- settlement deltas -------------------------------------------------------
    one('settle-001', 'under-delivery', 'The adapter delivers one atom less than the quantity.', e(buy, { script: honest(QTY - 1n, BUY_REFUND) })),
    one('settle-002', 'under-delivery', 'The adapter delivers nothing.', e(buy, { script: honest(0n, BUY_REFUND) })),
    one('settle-003', 'recipient-substitution', 'The adapter delivers the full quantity to someone else.', e(buy, { script: { ...buyOk(), deliverElsewhere: true } })),
    one('settle-004', 'under-proceeds', 'SELL proceeds one atom below the agent-signed minimum.', { unsigned: sell, script: honest(1_990n * E6 - 1n) }),
    one('settle-005', 'over-debit', 'The adapter pulls extra funding through an allowance the principal granted it directly.', e(buy, { script: { ...honest(QTY, 0n), mode: ScriptMode.PULL_FROM_PRINCIPAL, extraPull: 1n } }), (s) => s.map((t) => (t.token === ADDR.funding6 ? { ...t, adapterAllowance: 1n } : t))),
    one('settle-006', 'external-revert', 'The adapter reverts.', e(buy, { script: { ...buyOk(), mode: ScriptMode.REVERT } })),
    one('settle-007', 'transfer-failure', 'The principal allowance to the gate is one atom short.', e(buy), (s) => s.map((t) => (t.token === ADDR.funding6 ? { ...t, gateAllowance: 2_010n * E6 - 1n } : t))),
    one('settle-008', 'transfer-failure', 'The principal balance is one atom short.', e(buy), (s) => s.map((t) => (t.token === ADDR.funding6 ? { ...t, principalBalance: 2_010n * E6 - 1n } : t))),
    one('settle-009', 'exact-allowance', 'An exact per-mandate allowance, consumed exactly.', e(buy, { script: honest(QTY, 0n) }), (s) => s.map((t) => (t.token === ADDR.funding6 ? { ...t, gateAllowance: 2_010n * E6 } : t))),
    one('settle-010', 'unsupported-token-behaviour', 'The funding token\'s decimals changed after the gate pinned them.', e(buy), (s) => s.map((t) => (t.token === ADDR.funding6 ? { ...t, decimals: 18 } : t))),
    one('settle-011', 'unsupported-token-behaviour', 'The representation\'s decimals changed after the gate pinned them.', e(buy), (s) => s.map((t) => (t.token === ADDR.aapl ? { ...t, decimals: 6 } : t))),

    // --- replay -----------------------------------------------------------------
    { id: 'replay-001', family: 'replay', description: 'The identical attempt twice: the second is refused.', attempts: [e(buy), e(buy)] },
    { id: 'replay-002', family: 'replay', description: 'A second, differently-signed execution of a consumed mandate is refused.', attempts: [e(buy), e(withTerms(buy, { deadline: T0 + 301n }))] },
    { id: 'replay-003', family: 'retry', description: 'An attempt whose venue reverts consumes nothing; the retry settles.', attempts: [e(buy, { script: { ...buyOk(), mode: ScriptMode.REVERT } }), e(buy)] },
    { id: 'replay-004', family: 'retry', description: 'An attempt refused at settlement consumes nothing; the retry settles, then a replay is refused.', attempts: [e(buy, { script: honest(QTY - 1n, BUY_REFUND) }), e(buy), e(buy)] },
    { id: 'replay-005', family: 'replay', description: 'Two mandates differing only in nonce are independently spendable.', attempts: [e(buy), e(withMandate(buy, { nonce: 2n }))] },
    { id: 'replay-006', family: 'replay', description: 'Retried after expiry: time never restores or extends an authorization.', attempts: [e(buy, { script: { ...buyOk(), mode: ScriptMode.REVERT } }), e(withTerms(buy, { deadline: T0 + 99_999n }), { moment: now(T0 + 3_600n) })] },

    // --- structure --------------------------------------------------------------
    one('struct-001', 'mandate-version', 'MCE v1 mandate.', e(withMandate(buy, { version: 1n }))),
    one('struct-002', 'mandate-structure', 'Allowlist in non-canonical order, signed as given.', e(withMandate(buy, { allowedVenues: ['venue.fixture', 'venue.other'] }))),
    one('struct-003', 'mandate-structure', 'Duplicate allowlist entry.', e(withMandate(buy, { allowedIssuers: ['issuer.alpha', 'issuer.alpha'] }))),
    one('struct-004', 'mandate-structure', 'Identifier with a character outside the kernel charset.', e(withMandate(buy, { allowedIssuers: ['issuer alpha'] }))),
    one('struct-005', 'mandate-structure', 'Economic limit at 39 decimals.', e(withMandate(buy, { economicLimit: { unit: 'USD', decimals: 39, atoms: 1n } }))),
    one('struct-006', 'mandate-structure', 'Empty validity window.', e(withMandate(buy, { notBeforeUnixSeconds: T0 + 3_600n }))),
    one('struct-007', 'mandate-structure', 'Unassigned side wire code.', e(withMandate(buy, { side: 3n }))),
    one('struct-008', 'candidate-structure', 'Candidate schema v2.', e(withCandidate(buy, { version: 2n }))),
    one('struct-009', 'candidate-structure', 'Candidate identifier with a trailing separator.', e(withCandidate(buy, { evaluationStateId: 'state.fixture.' }))),
    one('struct-010', 'candidate-structure', 'Candidate price at 39 decimals.', e(withCandidate(buy, { executionPrice: { numeratorUnit: 'USD', denominatorUnit: 'TOKEN', decimals: 39, atoms: 1n } }))),
  ];
}

// --- Seeded mutations ----------------------------------------------------------

/** mulberry32: small, fixed, reproducible. Not a security primitive. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Seeded {
  readonly spec: AttemptSpec;
  readonly mutations: readonly string[];
}

function seededAttempts(count: number): Seeded[] {
  const r = rng(0x6d616e64);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const big = (max: bigint): bigint => {
    let v = 0n;
    for (let i = 0; i < 8; i += 1) v = (v << 32n) | BigInt(Math.floor(r() * 2 ** 32));
    return max === 0n ? 0n : v % (max + 1n);
  };

  type Op = (s: { u: Unsigned; moment: ChainMoment; script: Script | null; sign: Parameters<typeof sign>[1]; tamper: ((a: GateAttempt) => GateAttempt) | null }) => string;
  const ops: readonly Op[] = [
    (s) => { const t = pick([T0 - 61n, T0 - 60n, T0, T0 + 300n, T0 + 301n, T0 + 3_599n, T0 + 3_600n]); s.moment = now(t, s.moment.chainId); return `timestamp=${t - T0}`; },
    (s) => { const d = pick([-1n, 0n, 1n, -big(10n ** 9n)]); s.u = withTerms(s.u, { fundingLimit: s.u.terms.fundingLimit + d < 0n ? 0n : s.u.terms.fundingLimit + d }); return `fundingLimit+=${d}`; },
    (s) => { s.u = withTerms(s.u, { recipient: pick([STRANGER, ADDR.gate]) }); return 'recipient'; },
    (s) => { const d = pick([-301n, -1n, 0n, 1n, 4_000n]); s.u = withTerms(s.u, { deadline: s.u.terms.deadline + d }); return `deadline+=${d}`; },
    (s) => { s.u = withTerms(s.u, { executionData: '0x' + big(2n ** 64n).toString(16).padStart(16, '0') }); return 'executionData'; },
    (s) => { const field = pick(['nonce', 'limit', 'side', 'agent', 'expiry'] as const); s.tamper = (a) => ({ ...a, mandate: field === 'nonce' ? { ...a.mandate, nonce: a.mandate.nonce + 1n } : field === 'limit' ? { ...a.mandate, economicLimit: { ...a.mandate.economicLimit, atoms: a.mandate.economicLimit.atoms + 1n } } : field === 'side' ? { ...a.mandate, side: 3n - a.mandate.side } : field === 'agent' ? { ...a.mandate, agent: STRANGER } : { ...a.mandate, expiresAtUnixSeconds: a.mandate.expiresAtUnixSeconds + 1n } }); return `tamper-mandate.${field}`; },
    (s) => { const field = pick(['token', 'quantity', 'issuer'] as const); s.tamper = (a) => ({ ...a, candidate: field === 'token' ? { ...a.candidate, representationId: representationIdFor(CHAIN_ID, pick([ADDR.nvda, ADDR.synth, ADDR.unlisted])) } : field === 'quantity' ? { ...a.candidate, quantity: { ...a.candidate.quantity, atoms: a.candidate.quantity.atoms * 2n } } : { ...a.candidate, issuer: 'issuer.omega' } }); return `tamper-candidate.${field}`; },
    (s) => { const field = pick(['recipient', 'fundingLimit', 'deadline', 'data'] as const); s.tamper = (a) => ({ ...a, terms: field === 'recipient' ? { ...a.terms, recipient: STRANGER } : field === 'fundingLimit' ? { ...a.terms, fundingLimit: a.terms.fundingLimit + 1n } : field === 'deadline' ? { ...a.terms, deadline: a.terms.deadline + 1n } : { ...a.terms, executionData: '0xff' } }); return `tamper-terms.${field}`; },
    (s) => { const d = pick([0, 2, 6, 18, 30, 38]); const atoms = pick([0n, 1n, big(10n ** 30n), UINT256_MAX]); s.u = withMandate(s.u, { maxNotional: { unit: 'USD', decimals: d, atoms }, economicLimit: { unit: 'USD', decimals: d, atoms } }); return `limit=${atoms}@${d}`; },
    (s) => { const v = pick([['issuer.omega'], ['issuer.alpha', 'issuer.synthetic'], []] as string[][]); s.u = withMandate(s.u, { allowedIssuers: v }); return `issuers=${v.join('|')}`; },
    (s) => { const v = pick([['venue.other'], ['venue.fixture'], [], ['venue.other', 'venue.fixture']] as string[][]); s.u = withMandate(s.u, { allowedVenues: v }); return `venues=${v.join('|')}`; },
    (s) => { const v = pick([[], ['eip155:1'], ['eip155:1', caip2(CHAIN_ID)]] as string[][]); s.u = withMandate(s.u, { allowedChains: v }); return `chains=${v.join('|')}`; },
    (s) => { s.u = withMandate(s.u, { syntheticPolicy: 2n, allowedIssuers: ['issuer.alpha', 'issuer.synthetic'] }); return 'synthetic-allowed'; },
    (s) => { const t = pick([ADDR.nvda, ADDR.synth, ADDR.eightDecimal, ADDR.unlisted]); s.u = withCandidate(s.u, { representationId: representationIdFor(CHAIN_ID, t) }); return `token=${t.slice(-4)}`; },
    (s) => { const v = pick(['issuer.synthetic', 'issuer.omega']); s.u = withCandidate(s.u, { issuer: v }); return `candidate.issuer=${v}`; },
    (s) => { const v = pick(['venue.other', 'venue.omega']); s.u = withCandidate(s.u, { venue: v }); return `candidate.venue=${v}`; },
    (s) => { const atoms = pick([0n, 1n, big(10n ** 24n), 2_000_000n * E18]); s.u = withCandidate(s.u, { quantity: { ...s.u.candidate.quantity, atoms } }); return `quantity=${atoms}`; },
    (s) => { const d = pick([6, 8, 17]); s.u = withCandidate(s.u, { quantity: { ...s.u.candidate.quantity, decimals: d } }); return `quantity.decimals=${d}`; },
    (s) => { s.u = withCandidate(s.u, { agent: STRANGER }); return 'candidate.agent'; },
    (s) => { s.u = withCandidate(s.u, { side: 3n - s.u.candidate.side }); return 'candidate.side'; },
    (s) => { s.sign = { ...s.sign, principalKey: STRANGER_KEY }; return 'principal-key'; },
    (s) => { s.sign = { ...s.sign, agentKey: STRANGER_KEY }; return 'agent-key'; },
    (s) => { s.sign = { ...s.sign, agentDomain: pick([otherGateDomain, otherChainDomain]) }; return 'agent-domain'; },
    (s) => { const i = Math.floor(r() * 65); s.tamper = (a) => ({ ...a, agentSignature: hexWithByte(a.agentSignature, i, (Number.parseInt(a.agentSignature.slice(2 + i * 2, 4 + i * 2), 16) ^ 0x01)) }); return `flip-agent-sig[${i}]`; },
    (s) => { s.tamper = (a) => ({ ...a, principalSignature: malleate(a.principalSignature) }); return 'malleate-principal'; },
    (s) => { s.moment = now(s.moment.timestamp, pick([1n, 4663n, 42161n])); return `chain=${s.moment.chainId}`; },
    (s) => { s.script = { mode: ScriptMode.SCRIPTED, deliver: 0n, refund: 0n, deliverElsewhere: false, extraPull: 0n }; return 'script=nothing'; },
    (s) => { s.script = { mode: ScriptMode.REVERT, deliver: 0n, refund: 0n, deliverElsewhere: false, extraPull: 0n }; return 'script=revert'; },
    (s) => { s.script = { mode: ScriptMode.RETURN_GARBAGE, deliver: 0n, refund: 0n, deliverElsewhere: true, extraPull: 0n }; return 'script=garbage-elsewhere'; },
  ];

  // Mutations that keep the attempt authorized, so seeded vectors also reach
  // settlement arithmetic rather than stopping at the first refusal.
  const benign: readonly Op[] = [
    (s) => { const t = T0 - 60n + big(360n); s.moment = now(t, s.moment.chainId); return `timestamp=${t - T0}`; },
    (s) => { const f = s.u.candidate.side === 2n ? s.u.terms.fundingLimit + big(10n ** 9n) : big(s.u.terms.fundingLimit); s.u = withTerms(s.u, { fundingLimit: f }); return `fundingLimit=${f}`; },
    (s) => { const atoms = 1n + big(100n * E18); s.u = withCandidate(s.u, { quantity: { ...s.u.candidate.quantity, atoms } }); return `quantity=${atoms}`; },
    (s) => { s.u = withTerms(s.u, { executionData: '0x' + big(2n ** 64n).toString(16).padStart(16, '0') }); return 'executionData'; },
    (s) => { const n = 1n + big(2n ** 63n); s.u = withMandate(s.u, { nonce: n }); return `nonce=${n}`; },
  ];

  const out: Seeded[] = [];
  for (let i = 0; i < count; i += 1) {
    const isSell = r() < 0.4;
    const isBenign = r() < 0.35;
    const s = { u: isSell ? baseSell() : baseBuy(), moment: now(), script: null as Script | null, sign: {} as Parameters<typeof sign>[1], tamper: null as ((a: GateAttempt) => GateAttempt) | null };
    const mutations = [isSell ? 'SELL' : 'BUY'];
    const k = 1 + Math.floor(r() * 2);
    for (let j = 0; j < k; j += 1) mutations.push((pick(isBenign ? benign : ops) as Op)(s));

    // An honest adapter for whatever the mutations produced, unless a mutation scripted it.
    const quantity = s.u.candidate.quantity.atoms;
    const funding = s.u.terms.fundingLimit;
    const script: Script = s.script ?? (s.u.candidate.side === 2n
      ? honest(funding + big(10n ** 6n))
      : honest(quantity, big(funding)));
    const tamper = s.tamper;
    out.push({
      spec: {
        unsigned: s.u,
        moment: s.moment,
        script,
        signOptions: s.sign,
        ...(tamper === null ? {} : { tamper }),
      },
      mutations,
    });
  }
  return out;
}

// --- Encoding vectors ----------------------------------------------------------

interface MandateEncoding { readonly id: string; readonly source: string; readonly mandate: GateMandate; readonly validity: number; readonly digest: string }
interface CandidateEncoding { readonly id: string; readonly source: string; readonly candidate: GateCandidate; readonly valid: boolean; readonly digest: string }

const VALIDITY = { VALID: 0, UNSUPPORTED_VERSION: 1, MALFORMED: 2 } as const;
const ZERO32 = '0x' + '00'.repeat(32);

function corpusInputs(): { mandates: MandateEncoding[]; candidates: CandidateEncoding[] } {
  const mandates = new Map<string, MandateEncoding>();
  const candidates = new Map<string, CandidateEncoding>();
  for (const file of ['corpus/v2/vectors.json', 'corpus/mainnet-v1/vectors.json']) {
    const corpus = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as { vectors: { id: string; input: { mandate: unknown; candidate: unknown } }[] };
    for (const v of corpus.vectors) {
      const m = parseMandate(v.input.mandate);
      if (m.ok) {
        const g = toGateMandate(m.value);
        // The kernel's own encoder decides the expected digest.
        const digest = mandateDigest(m.value);
        if (g !== undefined && !mandates.has(digest)) mandates.set(digest, { id: `mandate-${mandates.size + 1}`, source: `${file}#${v.id}`, mandate: g, validity: VALIDITY.VALID, digest });
      }
      const c = parseCandidate(v.input.candidate);
      if (c.ok) {
        const g = toGateCandidate(c.value);
        const digest = candidateDigest(c.value);
        if (g !== undefined && !candidates.has(digest)) candidates.set(digest, { id: `candidate-${candidates.size + 1}`, source: `${file}#${v.id}`, candidate: g, valid: true, digest });
      }
    }
  }
  return { mandates: [...mandates.values()], candidates: [...candidates.values()] };
}

function seededValidation(count: number): { mandates: MandateEncoding[]; candidates: CandidateEncoding[] } {
  const r = rng(0x76616c69);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const identifiers = ['a', 'A.b', 'x'.repeat(128), 'x'.repeat(129), '', '.a', 'a.', 'a b', 'a/b:c-d_e', 'é', 'issuer.alpha', 'issuer.omega', 'Z9', '-', 'a..b'];
  const sets = [[], ['a'], ['b', 'a'], ['a', 'a'], ['a', 'bb'], ['bb', 'a'], ['a', 'b', 'cc'], ['a', ''], ['aa', 'ab'], ['ab', 'aa']];
  const mandates: MandateEncoding[] = [];
  const candidates: CandidateEncoding[] = [];
  for (let i = 0; i < count; i += 1) {
    const m = baseBuy().mandate;
    const field = pick(['version', 'side', 'synthetic', 'halt', 'asset', 'unit', 'decimals', 'issuers', 'chains', 'venues', 'window', 'units'] as const);
    const x: GateMandate =
      field === 'version' ? { ...m, version: pick([0n, 1n, 2n, 3n, 65535n]) }
      : field === 'side' ? { ...m, side: pick([0n, 1n, 2n, 3n, 255n]) }
      : field === 'synthetic' ? { ...m, syntheticPolicy: pick([0n, 1n, 2n, 3n]) }
      : field === 'halt' ? { ...m, haltPolicy: pick([0n, 1n, 2n, 3n]) }
      : field === 'asset' ? { ...m, canonicalAsset: { ...m.canonicalAsset, value: pick(identifiers) } }
      : field === 'unit' ? { ...m, economicLimit: { ...m.economicLimit, unit: pick(identifiers) } }
      : field === 'decimals' ? { ...m, economicLimit: { ...m.economicLimit, decimals: pick([0, 37, 38, 39, 255]) } }
      : field === 'issuers' ? { ...m, allowedIssuers: pick(sets) }
      : field === 'chains' ? { ...m, allowedChains: pick(sets) }
      : field === 'venues' ? { ...m, allowedVenues: pick(sets) }
      : field === 'window' ? { ...m, notBeforeUnixSeconds: m.expiresAtUnixSeconds + pick([-1n, 0n, 1n]) }
      : { ...m, maxNotional: { ...m.maxNotional, unit: pick(['USD', 'EUR']) } };
    const decoded = decodeGateMandate(x);
    const validity = decoded.ok ? VALIDITY.VALID : decoded.rejection.error === 'UnsupportedMandateVersion' ? VALIDITY.UNSUPPORTED_VERSION : VALIDITY.MALFORMED;
    mandates.push({ id: `mandate-seeded-${i + 1}`, source: `seeded:${field}`, mandate: x, validity, digest: decoded.ok ? decoded.value.digest : ZERO32 });

    const c = baseCandidate();
    const cfield = pick(['version', 'side', 'representationId', 'issuer', 'chain', 'venue', 'quantity', 'price', 'state'] as const);
    const y: GateCandidate =
      cfield === 'version' ? { ...c, version: pick([2n, 3n, 4n]) }
      : cfield === 'side' ? { ...c, side: pick([0n, 1n, 2n, 3n]) }
      : cfield === 'representationId' ? { ...c, representationId: pick(identifiers) }
      : cfield === 'issuer' ? { ...c, issuer: pick(identifiers) }
      : cfield === 'chain' ? { ...c, chain: pick(identifiers) }
      : cfield === 'venue' ? { ...c, venue: pick(identifiers) }
      : cfield === 'quantity' ? { ...c, quantity: { ...c.quantity, decimals: pick([0, 38, 39]), unit: pick(identifiers) } }
      : cfield === 'price' ? { ...c, executionPrice: { ...c.executionPrice, decimals: pick([18, 39]), denominatorUnit: pick(identifiers) } }
      : { ...c, evaluationStateId: pick(identifiers) };
    const cd = decodeGateCandidate(y);
    candidates.push({ id: `candidate-seeded-${i + 1}`, source: `seeded:${cfield}`, candidate: y, valid: cd.ok, digest: cd.ok ? cd.value.digest : ZERO32 });
  }
  return { mandates, candidates };
}

// --- Assembly ------------------------------------------------------------------

const TOKEN_SETUP = tuple(['token', address], ['principalBalance', uint(256)], ['gateAllowance', uint(256)], ['adapterAllowance', uint(256)], ['decimals', uint(8)]);
const SCRIPT = tuple(['mode', uint(8)], ['deliver', uint(256)], ['refund', uint(256)], ['deliverElsewhere', bool], ['extraPull', uint(256)]);
const EXPECTED = tuple(['settled', bool], ['revertData', bytes], ['mandateDigest', bytes32], ['candidateDigest', bytes32], ['executionCommitment', bytes32], ['debit', uint(256)], ['credit', uint(256)]);
const ATTEMPT = tuple(
  ['chainId', uint(256)],
  ['timestamp', uint(256)],
  ['mandate', MANDATE],
  ['principalSignature', bytes],
  ['candidate', CANDIDATE],
  ['terms', TERMS],
  ['agentSignature', bytes],
  ['script', SCRIPT],
  ['expected', EXPECTED],
);
const GATE_VECTOR = tuple(['id', string], ['setup', array(TOKEN_SETUP)], ['attempts', array(ATTEMPT)]);
const MANDATE_ENCODING = tuple(['id', string], ['mandate', MANDATE], ['validity', uint(8)], ['digest', bytes32]);
const CANDIDATE_ENCODING = tuple(['id', string], ['candidate', CANDIDATE], ['valid', bool], ['digest', bytes32]);

interface BuiltVector {
  readonly id: string;
  readonly family: string;
  readonly description: string;
  readonly setup: TokenSetup[];
  readonly attempts: { readonly sim: SimAttempt; readonly expected: Expected }[];
  readonly mutations?: readonly string[];
}

function build(spec: VectorSpec): BuiltVector {
  const setup = spec.setup === undefined ? defaultSetup() : spec.setup(defaultSetup());
  const sims: SimAttempt[] = spec.attempts.map((a) => {
    const signed = sign(a.unsigned, a.signOptions);
    return { moment: a.moment ?? now(), attempt: a.tamper === undefined ? signed : a.tamper(signed), script: a.script ?? buyOk() };
  });
  const expected = simulate(setup, sims);
  return { id: spec.id, family: spec.family, description: spec.description, setup, attempts: sims.map((sim, i) => ({ sim, expected: expected[i] as Expected })) };
}

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString(10) : v)));
}

function attemptAbiValue(a: { sim: SimAttempt; expected: Expected }) {
  return {
    chainId: a.sim.moment.chainId,
    timestamp: a.sim.moment.timestamp,
    mandate: a.sim.attempt.mandate,
    principalSignature: a.sim.attempt.principalSignature,
    candidate: a.sim.attempt.candidate,
    terms: a.sim.attempt.terms,
    agentSignature: a.sim.attempt.agentSignature,
    script: a.sim.script,
    expected: a.expected,
  };
}

export interface GateCorpus {
  /** Committed: `corpus/gate-v1/vectors.json`. */
  readonly readable: Record<string, unknown>;
  /** Not committed: the same entries ABI-encoded for `Differential.t.sol`. */
  readonly abi: Record<string, unknown>;
}

export function generateGateCorpus(): GateCorpus {
  const hand = handWritten().map(build);
  const seeded = seededAttempts(SEEDED_VECTOR_COUNT).map((s, i) => ({
    ...build({ id: `seeded-${String(i + 1).padStart(3, '0')}`, family: 'seeded-mutation', description: s.mutations.join(', '), attempts: [s.spec] }),
    mutations: s.mutations,
  }));
  const vectors = [...hand, ...seeded];
  const fromCorpora = corpusInputs();
  const validation = seededValidation(SEEDED_VALIDATION_COUNT);
  const mandateEncodings = [...fromCorpora.mandates, ...validation.mandates];
  const candidateEncodings = [...fromCorpora.candidates, ...validation.candidates];

  const settled = vectors.flatMap((v) => v.attempts).filter((a) => a.expected.settled).length;
  const attempts = vectors.reduce((n, v) => n + v.attempts.length, 0);

  const readable = {
    corpusVersion: GATE_CORPUS_VERSION,
    gate: 'contracts/src/MandateExecutionGate.sol',
    model: 'packages/execution-gate/src/model.ts',
    encoding: 'MCE v2 mandate, Candidate V3, EIP-712 {Mandate, 1, chainId, gate} (docs/execution-gate.md)',
    note: 'Integers are decimal strings. The Solidity harness replays the ABI form of these same entries, written by the same generator run to contracts/generated/gate-v1.abi.json (not committed). Tokens are labelled fixtures and the adapter is ScriptedAdapter: this corpus exercises the gate decision, not a venue.',
    world: toJson({ chainId: CHAIN_ID, gate: ADDR.gate, adapter: ADDR.adapter, domain: DOMAIN, tokens: defaultSetup().map((t) => t.token), seeds: { vectors: '0x6d616e64', validation: '0x76616c69' } }),
    counts: { vectors: vectors.length, attempts, settledAttempts: settled, revertedAttempts: attempts - settled, mandateEncodings: mandateEncodings.length, candidateEncodings: candidateEncodings.length },
    vectors: vectors.map((v) => toJson({
      id: v.id,
      family: v.family,
      description: v.description,
      ...(v.mutations === undefined ? {} : { mutations: v.mutations }),
      attempts: v.attempts.map((a) => ({
        chainId: a.sim.moment.chainId,
        timestamp: a.sim.moment.timestamp,
        expected: a.expected,
        // Full inputs only for the hand-written families; seeded inputs are in `abi`.
        ...(v.family === 'seeded-mutation' ? {} : { script: a.sim.script, input: a.sim.attempt }),
      })),
    })),
    mandateEncodings: mandateEncodings.map((m) => ({ id: m.id, source: m.source, validity: m.validity, digest: m.digest })),
    candidateEncodings: candidateEncodings.map((c) => ({ id: c.id, source: c.source, valid: c.valid, digest: c.digest })),
  };
  const abi = {
    corpusVersion: GATE_CORPUS_VERSION,
    vectors: vectors.map((v) => abiEncode(GATE_VECTOR, { id: v.id, setup: v.setup, attempts: v.attempts.map(attemptAbiValue) })),
    mandateEncodings: mandateEncodings.map((m) => abiEncode(MANDATE_ENCODING, m)),
    candidateEncodings: candidateEncodings.map((c) => abiEncode(CANDIDATE_ENCODING, c)),
  };
  return { readable, abi };
}

export const READABLE_PATH = 'corpus/gate-v1/vectors.json';
export const ABI_PATH = 'contracts/generated/gate-v1.abi.json';

export function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const corpus = generateGateCorpus();
  mkdirSync(resolve(ROOT, 'contracts/generated'), { recursive: true });
  writeFileSync(resolve(ROOT, READABLE_PATH), serialize(corpus.readable));
  writeFileSync(resolve(ROOT, ABI_PATH), serialize(corpus.abi));
}
