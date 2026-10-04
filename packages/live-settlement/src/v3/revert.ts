/** Decode the standard ERC-6093 balance error surfaced by V3 simulation. */

export const ERC20_INSUFFICIENT_BALANCE_SELECTOR = '0xe450d38c';

export interface Erc20InsufficientBalance {
  readonly kind: 'ERC20InsufficientBalance';
  readonly sender: string;
  readonly balance: bigint;
  readonly needed: bigint;
  readonly rawRevert: string;
}

export function decodeErc20InsufficientBalance(revert: string): Erc20InsufficientBalance | null {
  const raw = revert.toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(raw) || raw.length !== 2 + 8 + 64 * 3) return null;
  const hex = raw.slice(2);
  if (`0x${hex.slice(0, 8)}` !== ERC20_INSUFFICIENT_BALANCE_SELECTOR) return null;
  const senderWord = hex.slice(8, 72);
  if (!/^0{24}[0-9a-f]{40}$/.test(senderWord)) return null;
  return {
    kind: 'ERC20InsufficientBalance',
    sender: `0x${senderWord.slice(24)}`,
    balance: BigInt(`0x${hex.slice(72, 136)}`),
    needed: BigInt(`0x${hex.slice(136, 200)}`),
    rawRevert: raw,
  };
}

export type V3SimulationFailure =
  | {
      readonly code:
        | 'V3_FIXTURE_INVENTORY_INSUFFICIENT'
        | 'V3_PRINCIPAL_BALANCE_INSUFFICIENT'
        | 'V3_ERC20_BALANCE_INSUFFICIENT';
      readonly detail: Erc20InsufficientBalance;
    }
  | { readonly code: string; readonly detail: null };

export function classifyV3SimulationRevert(revert: string, principal: string, fixtureVenue: string): V3SimulationFailure {
  const detail = decodeErc20InsufficientBalance(revert);
  if (detail === null) return { code: `SIMULATION_REVERT.${revert}`, detail: null };
  if (detail.sender === fixtureVenue.toLowerCase()) return { code: 'V3_FIXTURE_INVENTORY_INSUFFICIENT', detail };
  if (detail.sender === principal.toLowerCase()) return { code: 'V3_PRINCIPAL_BALANCE_INSUFFICIENT', detail };
  return { code: 'V3_ERC20_BALANCE_INSUFFICIENT', detail };
}
