/**
 * The browser's wallet adapter: a narrow wrapper around an injected
 * EIP-1193 provider (`window.ethereum`).
 *
 * It can connect, read the account and the chain, ask the wallet to switch
 * to Robinhood Chain testnet, sign EIP-712 typed data the local server built,
 * and — only for V3 settlement setup — submit one bounded ERC-20
 * `approve(V3Gate, amount)` transaction. Raw signing and unlimited approvals
 * are refused. Settlement broadcasts still use the lab submitter, never this
 * wallet, except the bounded principal MDUSD settlement allowance.
 */

import { UINT256_MAX, type TrustedSettlementPlan, boundedApproveTx } from "./settlement-setup.ts";

/** The only wallet methods this app ever calls. */
export const WALLET_METHODS = [
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "eth_call",
  "eth_getTransactionReceipt",
] as const;
type WalletMethod = (typeof WALLET_METHODS)[number];

/** Robinhood Chain testnet: where wallet approvals are bound (the server's EIP-712 domain). */
export const APPROVAL_CHAIN = {
  chainId: 46630,
  hex: "0xb626",
  name: "Robinhood Chain Testnet",
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
} as const;

interface Eip1193 {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
}

export interface WalletError {
  readonly code: "NO_WALLET" | "REJECTED" | "WRONG_CHAIN" | "FAILED";
  readonly message: string;
}

export type WalletResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: WalletError };

export interface WalletAdapter {
  connect(): Promise<WalletResult<string>>;
  getAccounts(): Promise<WalletResult<readonly string[]>>;
  getChainId(): Promise<WalletResult<number>>;
  switchChain(): Promise<WalletResult<true>>;
  signTypedData(address: string, typedData: unknown): Promise<WalletResult<string>>;
  /**
   * Bounded MDUSD.approve(V3Gate, amount) from the trusted plan. Renew when insufficient.
   * Refuses wrong chain, principal mismatch, and unlimited amounts.
   */
  sendBoundedErc20Approve(plan: TrustedSettlementPlan): Promise<WalletResult<string>>;
  ethCall(to: string, data: string): Promise<WalletResult<string>>;
  waitForReceipt(txHash: string, timeoutMs?: number): Promise<WalletResult<"SUCCESS" | "REVERTED">>;
}

function failure(e: unknown): WalletError {
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : null;
  if (code === 4001) return { code: "REJECTED", message: "The request was rejected in the wallet. Nothing was signed." };
  return { code: "FAILED", message: "The wallet could not complete the request. Nothing was signed." };
}

/** The injected provider, if the browser has one. */
function injected(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  const provider = (window as unknown as { ethereum?: unknown }).ethereum;
  return typeof provider === "object" && provider !== null && typeof (provider as { request?: unknown }).request === "function" ? (provider as Eip1193) : null;
}

export function walletAvailable(): boolean {
  return injected() !== null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A wallet adapter over the injected provider, or null when there is none. */
export function injectedWallet(provider: Eip1193 | null = injected()): WalletAdapter | null {
  if (provider === null) return null;
  const call = async (method: WalletMethod, params: readonly unknown[] = []): Promise<WalletResult<unknown>> => {
    if (!(WALLET_METHODS as readonly string[]).includes(method)) return { ok: false, error: { code: "FAILED", message: "Not an allowed wallet request." } };
    try {
      return { ok: true, value: await provider.request({ method, params }) };
    } catch (e) {
      return { ok: false, error: failure(e) };
    }
  };
  const accounts = (v: unknown): readonly string[] => (Array.isArray(v) ? v.filter((a): a is string => typeof a === "string" && ADDRESS.test(a)).map((a) => a.toLowerCase()) : []);
  return {
    async connect() {
      const r = await call("eth_requestAccounts");
      if (!r.ok) return r;
      const first = accounts(r.value)[0];
      return first === undefined ? { ok: false, error: { code: "FAILED", message: "The wallet returned no account." } } : { ok: true, value: first };
    },
    async getAccounts() {
      const r = await call("eth_accounts");
      return r.ok ? { ok: true, value: accounts(r.value) } : r;
    },
    async getChainId() {
      const r = await call("eth_chainId");
      if (!r.ok) return r;
      const id = typeof r.value === "string" ? Number.parseInt(r.value, 16) : Number.NaN;
      return Number.isSafeInteger(id) ? { ok: true, value: id } : { ok: false, error: { code: "FAILED", message: "The wallet reported no chain." } };
    },
    async switchChain() {
      const r = await call("wallet_switchEthereumChain", [{ chainId: APPROVAL_CHAIN.hex }]);
      if (r.ok) return { ok: true, value: true };
      // 4902: the wallet does not know the chain yet. Offer the public testnet RPC; it carries no credential.
      const add = await call("wallet_addEthereumChain", [{ chainId: APPROVAL_CHAIN.hex, chainName: APPROVAL_CHAIN.name, rpcUrls: [APPROVAL_CHAIN.rpcUrl], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: [APPROVAL_CHAIN.explorer] }]);
      return add.ok ? { ok: true, value: true } : add;
    },
    async signTypedData(address, typedData) {
      if (!ADDRESS.test(address)) return { ok: false, error: { code: "FAILED", message: "No connected wallet address." } };
      const r = await call("eth_signTypedData_v4", [address, JSON.stringify(typedData)]);
      if (!r.ok) return r;
      return typeof r.value === "string" && /^0x[0-9a-fA-F]{130}$/.test(r.value) ? { ok: true, value: r.value } : { ok: false, error: { code: "FAILED", message: "The wallet returned no signature." } };
    },
    async sendBoundedErc20Approve(plan) {
      if (plan.chainId !== APPROVAL_CHAIN.chainId) {
        return { ok: false, error: { code: "WRONG_CHAIN", message: "Settlement setup only runs on Robinhood Chain testnet." } };
      }
      const chain = await this.getChainId();
      if (!chain.ok) return chain;
      if (chain.value !== APPROVAL_CHAIN.chainId) {
        return { ok: false, error: { code: "WRONG_CHAIN", message: "Switch your wallet to Robinhood Chain testnet before enabling settlement." } };
      }
      const amount = BigInt(plan.requiredAllowanceAtoms);
      if (amount <= 0n || amount >= UINT256_MAX) {
        return { ok: false, error: { code: "FAILED", message: "Unlimited or zero approval is refused." } };
      }
      const built = boundedApproveTx(plan, plan.principal);
      if (!built.ok) return { ok: false, error: { code: "FAILED", message: built.reason } };
      const r = await call("eth_sendTransaction", [built.tx]);
      if (!r.ok) return r;
      return typeof r.value === "string" && TX_HASH.test(r.value)
        ? { ok: true, value: r.value.toLowerCase() }
        : { ok: false, error: { code: "FAILED", message: "The wallet returned no transaction hash." } };
    },
    async ethCall(to, data) {
      if (!ADDRESS.test(to) || !/^0x[0-9a-fA-F]*$/.test(data)) {
        return { ok: false, error: { code: "FAILED", message: "Invalid eth_call." } };
      }
      const r = await call("eth_call", [{ to, data }, "latest"]);
      if (!r.ok) return r;
      return typeof r.value === "string" && /^0x[0-9a-fA-F]*$/.test(r.value)
        ? { ok: true, value: r.value }
        : { ok: false, error: { code: "FAILED", message: "eth_call returned no data." } };
    },
    async waitForReceipt(txHash, timeoutMs = 120_000) {
      if (!TX_HASH.test(txHash)) return { ok: false, error: { code: "FAILED", message: "Invalid transaction hash." } };
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const r = await call("eth_getTransactionReceipt", [txHash]);
        if (!r.ok) return r;
        if (r.value !== null && typeof r.value === "object") {
          const status = (r.value as { status?: unknown }).status;
          if (status === "0x1" || status === 1 || status === "1") return { ok: true, value: "SUCCESS" };
          if (status === "0x0" || status === 0 || status === "0") return { ok: true, value: "REVERTED" };
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return { ok: false, error: { code: "FAILED", message: "Timed out waiting for the approval transaction." } };
    },
  };
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
