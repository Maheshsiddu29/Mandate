/**
 * `npm run portfolio:demo` — the Phase 7F demonstration, offline.
 *
 * Five agents, one principal, one authority: prints the negotiation round by
 * round, the reservations the ledger made, the execution results with their
 * evidence classes, and the receipt digest. **Labelled fixtures; no network,
 * no key beyond publicly derived demonstration keys, no transaction.**
 */

import { amountOf, type Reason, type ResourceVector } from '../src/index.ts';
import { runDemo } from '../src/demo/index.ts';

const usdc = (atoms: bigint) => `${atoms / 1_000_000n}${atoms % 1_000_000n === 0n ? '' : `.${(atoms % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')}`}`;
const vector = (v: ResourceVector) => v.map((a) => `${a.resource} ${usdc(a.atoms)}`).join(', ');
const reasons = (rs: readonly Reason[]) => [...new Set(rs.map((r) => r.code))].join(', ');

const r = await runDemo();
const m = r.core.compiled.mandate;
const label = new Map(m.agents.map((a) => [a.agent.value as string, a.label as string]));
const out: string[] = [];
out.push('Mandate — Phase 7F portfolio demonstration (offline, labelled fixtures, no transaction)');
out.push(`principal ${m.principal.value}   mode ${m.allocationMode}   portfolio-notional ${usdc(amountOf(m.limits, 'portfolio-notional'))} USDC`);
out.push('');
for (let round = 1; round <= r.room.rounds; round += 1) {
  out.push(`round ${round}`);
  for (const x of r.room.releases.filter((y) => y.round === round)) out.push(`  ${label.get(x.agent)?.padEnd(6)} RELEASE ${x.applied ? 'applied' : `refused: ${reasons(x.reasons)}`}`);
  for (const d of r.room.decisions.filter((y) => y.round === round)) {
    const detail = d.outcome === 'ACCEPTED' ? vector(d.demand) : d.outcome === 'REDUCE_REQUESTED' ? `${reasons(d.reasons)} → reduce to ${vector(d.target)}` : reasons(d.reasons);
    out.push(`  ${label.get(d.agent)?.padEnd(6)} ${d.outcome.padEnd(16)} ${detail}`);
  }
}
out.push('');
out.push(`verification  ${r.verification.status}`);
out.push(`reserved      ${vector(r.after.reserved.filter((a) => a.atoms > 0n))}`);
for (const e of r.executions) out.push(`execution     ${e.integration.padEnd(26)} ${e.status.padEnd(22)} this run: ${e.evidence.padEnd(13)} integration: ${e.integrationEvidence}`);
out.push(`agents        ${r.receipt.agents.map((a) => `${a.label} ${a.status}`).join(' · ')}`);
out.push(`transactions  ${r.receipt.transactions}`);
out.push(`receipt       ${r.digest}`);
process.stdout.write(`${out.join('\n')}\n`);
