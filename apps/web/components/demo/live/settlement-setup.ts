/**
 * Pure helpers for bounded V3 MDUSD settlement-allowance setup.
 * Gate, token and amount come only from the server's trusted plan.
 * The browser never invents those addresses or accepts them as user input.
 */

export const UINT256_MAX = (1n << 256n) - 1n;
/** ERC-20 approve(address,uint256) selector. */
export const APPROVE_SELECTOR = "0x095ea7b3";
export const ALLOWANCE_SELECTOR = "0xdd62ed3e";

export type SettlementSetupStatus =
  | "IDLE"
  | "LOADING"
  | "NEED_ENABLE"
  | "SUBMITTING"
  | "CONFIRMING"
  | "READY"
  | "FAILED";

export interface TrustedSettlementPlan {
  readonly chainId: number;
  readonly gate: string;
  readonly fundingToken: string;
  readonly requiredAllowanceAtoms: string;
  readonly principal: string;
  readonly basis: "PLAN" | "MAXIMUM";
}

export type PlanParse =
  | { readonly ok: true; readonly plan: TrustedSettlementPlan }
  | { readonly ok: false; readonly reason: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ATOMS = /^[0-9]+$/;

/** Parse the server's settlement-setup body. Rejects browser-invented shapes. */
export function parseTrustedSettlementPlan(body: unknown, connectedPrincipal: string): PlanParse {
  if (body === null || typeof body !== "object") return { ok: false, reason: "Settlement setup plan missing." };
  const o = body as {
    chainId?: unknown;
    gate?: unknown;
    fundingToken?: unknown;
    requiredAllowanceAtoms?: unknown;
    principal?: unknown;
    basis?: unknown;
  };
  if (o.chainId !== 46_630) return { ok: false, reason: "Settlement setup refused: chain must be Robinhood Chain testnet (46630)." };
  if (typeof o.gate !== "string" || !ADDRESS.test(o.gate)) return { ok: false, reason: "Settlement setup refused: Gate missing." };
  if (typeof o.fundingToken !== "string" || !ADDRESS.test(o.fundingToken)) return { ok: false, reason: "Settlement setup refused: funding token missing." };
  if (typeof o.requiredAllowanceAtoms !== "string" || !ATOMS.test(o.requiredAllowanceAtoms)) {
    return { ok: false, reason: "Settlement setup refused: required allowance missing." };
  }
  if (typeof o.principal !== "string" || !ADDRESS.test(o.principal)) return { ok: false, reason: "Settlement setup refused: principal missing." };
  if (o.basis !== "PLAN" && o.basis !== "MAXIMUM") return { ok: false, reason: "Settlement setup refused: basis missing." };
  const amount = BigInt(o.requiredAllowanceAtoms);
  if (amount <= 0n) return { ok: false, reason: "Settlement setup refused: allowance must be positive." };
  if (amount >= UINT256_MAX) return { ok: false, reason: "Settlement setup refused: unlimited approval is not allowed." };
  const principal = o.principal.toLowerCase();
  if (principal !== connectedPrincipal.toLowerCase()) {
    return { ok: false, reason: "Settlement setup refused: plan principal is not the connected wallet." };
  }
  return {
    ok: true,
    plan: {
      chainId: 46_630,
      gate: o.gate.toLowerCase(),
      fundingToken: o.fundingToken.toLowerCase(),
      requiredAllowanceAtoms: amount.toString(),
      principal,
      basis: o.basis,
    },
  };
}

export function padAddressWord(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export function padUintWord(atoms: bigint): string {
  return atoms.toString(16).padStart(64, "0");
}

/** Exact approve(spender, amount) calldata. Amount must be the trusted bounded cap. */
export function encodeApproveCalldata(spender: string, amountAtoms: bigint): string | null {
  if (!ADDRESS.test(spender) || amountAtoms <= 0n || amountAtoms >= UINT256_MAX) return null;
  return `${APPROVE_SELECTOR}${padAddressWord(spender)}${padUintWord(amountAtoms)}`;
}

/** allowance(owner, spender) calldata. */
export function encodeAllowanceCalldata(owner: string, spender: string): string | null {
  if (!ADDRESS.test(owner) || !ADDRESS.test(spender)) return null;
  return `${ALLOWANCE_SELECTOR}${padAddressWord(owner)}${padAddressWord(spender)}`;
}

export function decodeUint256Word(hex: string): bigint | null {
  if (!/^0x[0-9a-fA-F]+$/.test(hex) || hex.length < 66) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

export function allowanceSufficient(have: bigint, requiredAtoms: string): boolean {
  return have >= BigInt(requiredAtoms);
}

/** Human label for MDUSD atoms (6 decimals). Exact display for the approve amount. */
export function formatMdusdAtoms(atoms: string): string {
  const n = BigInt(atoms);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  if (frac === 0n) return `${whole.toString()} MDUSD`;
  const fracText = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracText} MDUSD`;
}

export function readinessAfterAllowance(have: bigint, requiredAtoms: string): "NEED_ENABLE" | "READY" {
  return allowanceSufficient(have, requiredAtoms) ? "READY" : "NEED_ENABLE";
}

/** Build eth_sendTransaction params for the bounded approve. Refuses unlimited. */
export function boundedApproveTx(plan: TrustedSettlementPlan, from: string):
  | { readonly ok: true; readonly tx: { readonly from: string; readonly to: string; readonly data: string; readonly value: "0x0" } }
  | { readonly ok: false; readonly reason: string } {
  if (from.toLowerCase() !== plan.principal) return { ok: false, reason: "Connected wallet is not the settlement principal." };
  const amount = BigInt(plan.requiredAllowanceAtoms);
  if (amount >= UINT256_MAX) return { ok: false, reason: "Unlimited approval is refused." };
  const data = encodeApproveCalldata(plan.gate, amount);
  if (data === null) return { ok: false, reason: "Could not encode bounded approval." };
  return {
    ok: true,
    tx: {
      from: plan.principal,
      to: plan.fundingToken,
      data,
      value: "0x0",
    },
  };
}
