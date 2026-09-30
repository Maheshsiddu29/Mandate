/**
 * Preflight: what the chain says before anything is built for it.
 *
 * Safe information only — public addresses, balances, code-hash matches,
 * chain id, block. The chain id is asked of the RPC itself, never inferred
 * from a host name. Every deployed contract's runtime code hash and the
 * gate's domain separator must equal what the manifest recorded; the
 * submitter must be the manifest's deployer; the principal must hold, and
 * have allowed the gate, at least the fixture debit; the venue must hold the
 * quantity; the submitter must have gas. Anything missing is named and
 * nothing is sent.
 */

import { ROBINHOOD_TESTNET, type TestnetDeployment } from './deployment.ts';
import type { TestnetRpc } from './rpc.ts';

/** Gas the submitter must hold: 0.0001 testnet ETH, about fifteen times a gate execution at the observed base fee. */
export const MIN_SUBMITTER_WEI = 100_000_000_000_000n;

export interface ContractCheck {
  readonly name: string;
  readonly address: string;
  readonly hasCode: boolean;
  readonly codeHashMatchesManifest: boolean;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly rpcReachable: boolean;
  readonly chainId: string | null;
  readonly block: string | null;
  readonly blockTimestamp: string | null;
  readonly submitter: { readonly address: string; readonly nativeWei: string | null };
  readonly principal: { readonly address: string; readonly nativeWei: string | null; readonly mdusdAtoms: string | null; readonly mdemoAtoms: string | null; readonly mdusdAllowanceToGate: string | null };
  readonly agent: { readonly address: string };
  readonly venueMdemoAtoms: string | null;
  readonly contracts: readonly ContractCheck[];
  readonly gateDomainSeparatorMatchesManifest: boolean;
  readonly required: { readonly debitMdusdAtoms: string; readonly quantityMdemoAtoms: string } | null;
}

const text = (r: { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly error: string }) => (r.ok ? r.value.toString() : null);

export async function preflight(rpc: TestnetRpc, d: TestnetDeployment, need: { readonly debit: bigint; readonly quantity: bigint } | null): Promise<PreflightReport> {
  const failures: string[] = [];
  const id = await rpc.chainId();
  if (!id.ok) failures.push(`RPC_UNREACHABLE.${id.error}`);
  else if (id.value !== ROBINHOOD_TESTNET) failures.push(`WRONG_CHAIN.${id.value}`);
  const chainOk = id.ok && id.value === ROBINHOOD_TESTNET;
  // Nothing further is read from a chain that is not the testnet.
  const block = chainOk ? await rpc.latest() : null;
  if (block !== null && !block.ok) failures.push(`BLOCK_UNREADABLE.${block.error}`);

  const contracts: ContractCheck[] = [];
  let separatorOk = false;
  let submitterWei: bigint | null = null;
  let principalWei = null as string | null;
  let mdusd = null as string | null;
  let mdemo = null as string | null;
  let allowance = null as string | null;
  let venue = null as string | null;
  if (chainOk) {
    for (const [name, c] of [['MandateExecutionGate', d.gate], ['FixtureVenue', d.venue], ['FixtureVenueAdapter', d.adapter], ['MDEMO', d.mdemo], ['MDUSD', d.mdusd]] as const) {
      const h = await rpc.codehash(c.address);
      const check = { name, address: c.address, hasCode: h.ok, codeHashMatchesManifest: h.ok && h.value === c.runtimeCodeHash };
      contracts.push(check);
      if (!check.hasCode) failures.push(`NO_CODE.${name}`);
      else if (!check.codeHashMatchesManifest) failures.push(`CODE_HASH_NOT_MANIFEST.${name}`);
    }
    const sep = await rpc.domainSeparator(d.gate.address);
    separatorOk = sep.ok && sep.value === d.gate.domainSeparator;
    if (!separatorOk) failures.push('GATE_DOMAIN_SEPARATOR_NOT_MANIFEST');
    if (rpc.submitter !== d.submitter) failures.push('SUBMITTER_NOT_MANIFEST_DEPLOYER');
    const [sw, pw, u, e, a, v] = await Promise.all([
      rpc.nativeBalance(rpc.submitter),
      rpc.nativeBalance(d.principal),
      rpc.tokenBalance(d.mdusd.address, d.principal),
      rpc.tokenBalance(d.mdemo.address, d.principal),
      rpc.allowance(d.mdusd.address, d.principal, d.gate.address),
      rpc.tokenBalance(d.mdemo.address, d.venue.address),
    ]);
    submitterWei = sw.ok ? sw.value : null;
    principalWei = text(pw);
    mdusd = text(u);
    mdemo = text(e);
    allowance = text(a);
    venue = text(v);
    if (submitterWei === null) failures.push('SUBMITTER_BALANCE_UNREADABLE');
    else if (submitterWei < MIN_SUBMITTER_WEI) failures.push(`SUBMITTER_GAS_INSUFFICIENT.have_${submitterWei}_need_${MIN_SUBMITTER_WEI}_wei`);
    if (need !== null) {
      if (!u.ok) failures.push('PRINCIPAL_MDUSD_UNREADABLE');
      else if (u.value < need.debit) failures.push(`PRINCIPAL_MDUSD_INSUFFICIENT.have_${u.value}_need_${need.debit}`);
      if (!a.ok) failures.push('ALLOWANCE_UNREADABLE');
      else if (a.value < need.debit) failures.push(`GATE_ALLOWANCE_INSUFFICIENT.have_${a.value}_need_${need.debit}`);
      if (!v.ok) failures.push('VENUE_INVENTORY_UNREADABLE');
      else if (v.value < need.quantity) failures.push(`VENUE_MDEMO_INSUFFICIENT.have_${v.value}_need_${need.quantity}`);
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    rpcReachable: id.ok,
    chainId: id.ok ? id.value.toString() : null,
    block: block !== null && block.ok ? block.value.number.toString() : null,
    blockTimestamp: block !== null && block.ok ? block.value.timestamp.toString() : null,
    submitter: { address: rpc.submitter, nativeWei: submitterWei === null ? null : submitterWei.toString() },
    principal: { address: d.principal, nativeWei: principalWei, mdusdAtoms: mdusd, mdemoAtoms: mdemo, mdusdAllowanceToGate: allowance },
    agent: { address: d.agent },
    venueMdemoAtoms: venue,
    contracts,
    gateDomainSeparatorMatchesManifest: separatorOk,
    required: need === null ? null : { debitMdusdAtoms: need.debit.toString(), quantityMdemoAtoms: need.quantity.toString() },
  };
}
