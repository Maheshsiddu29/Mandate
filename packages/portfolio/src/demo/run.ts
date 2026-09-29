/**
 * The demonstration run: five agents, one principal, one authority.
 * **Offline, deterministic, labelled fixtures; no transaction.**
 *
 * The demo mandate is compiled into Core and registered in a fresh
 * in-memory ledger through the unchanged control engine; the five agents
 * negotiate in the Mandate Room; the verifier re-derives the result; each
 * child is reserved through the control engine; fixture children are
 * admitted and simulated, stock and perps children are handed to their
 * domains' existing signers (not run here).
 */

import type { Identifier } from '@mandate/kernel';
import {
  compilePortfolio,
  createPortfolioCore,
  defaultExecutor,
  mandateSigningHash,
  portfolioMandateDigest,
  registerPortfolio,
  runPortfolio,
  type PortfolioCore,
  type PortfolioCoreOptions,
  type PortfolioRun,
} from '../index.ts';
import { demoAgentStrategies } from './agents.ts';
import { demoKey, signPrehash } from './keys.ts';
import { DEMO_T0 } from './markets.ts';
import { demoBindings, demoMandate } from './mandate.ts';

/** The demonstration's decision time. */
export const DEMO_NOW = DEMO_T0 + 1_000n;

export interface DemoRun extends PortfolioRun {
  readonly core: PortfolioCore;
  readonly signature: string;
}

export function demoPrincipalSignature(): string {
  return signPrehash(mandateSigningHash(portfolioMandateDigest(demoMandate())), demoKey('principal'));
}

export async function runDemo(o: PortfolioCoreOptions = {}): Promise<DemoRun> {
  const m = demoMandate();
  const bindings = demoBindings();
  const compiled = compilePortfolio(m, bindings);
  if (!compiled.ok) throw new Error(`demo mandate does not compile: ${compiled.error.map((r) => r.code).join(', ')}`);
  const core = createPortfolioCore(compiled.value, o);
  const registered = await registerPortfolio(core, DEMO_T0);
  if (!registered.ok) throw new Error(`demo portfolio does not register: ${registered.error.map((r) => r.code).join(', ')}`);
  const signature = demoPrincipalSignature();
  const run = await runPortfolio({ core, signature, now: DEMO_NOW, agents: demoAgentStrategies(m, compiled.value.bindings, DEMO_NOW), execute: defaultExecutor(core) });
  return { ...run, core, signature };
}

export const DEMO_LABEL = 'mandate-portfolio.demo.v1' as Identifier;
