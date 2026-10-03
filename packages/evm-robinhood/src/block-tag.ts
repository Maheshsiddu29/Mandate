/**
 * The one JSON-RPC block identifier encoder (C1.4). Every block parameter
 * this package sends — `eth_call`, `eth_getCode`, `eth_getBlockByNumber`,
 * `eth_getBalance`, `eth_getTransactionCount` — goes through it.
 *
 * A block number is a JSON-RPC QUANTITY: `0x`-prefixed lowercase hex with no
 * leading zeros (`0x0` for zero). Nitro rejects a decimal string outright
 * (`-32602 hex string without 0x prefix`) and bounds a block number to int64,
 * so anything else — a JS number, a string, a negative, a value past int64 —
 * is refused here rather than sent and misread by an endpoint.
 */

export type BlockTagName = 'latest' | 'pending' | 'safe' | 'finalized';
export type BlockTag = bigint | BlockTagName;

/** Nitro and go-ethereum parse a block number into an int64. */
export const MAX_BLOCK_NUMBER = 2n ** 63n - 1n;

const NAMES: readonly string[] = ['latest', 'pending', 'safe', 'finalized'];

export type EncodedBlockTag = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: 'BLOCK_TAG_INVALID' };

export function encodeBlockTag(tag: BlockTag): EncodedBlockTag {
  if (typeof tag === 'bigint') {
    if (tag < 0n || tag > MAX_BLOCK_NUMBER) return { ok: false, error: 'BLOCK_TAG_INVALID' };
    return { ok: true, value: `0x${tag.toString(16)}` };
  }
  if (typeof tag === 'string' && NAMES.includes(tag)) return { ok: true, value: tag };
  return { ok: false, error: 'BLOCK_TAG_INVALID' };
}

/**
 * Why an endpoint could not serve a read pinned to `block`, when the answer
 * was about the block and not about the contract:
 *
 * - `AHEAD_OF_NODE` — Nitro's `unsupported block number N` for exactly the
 *   requested N: the answering node has not reached that block yet. Behind a
 *   load-balanced endpoint, the node that reported `latest` and the node
 *   that serves the pinned read can differ.
 * - `STATE_PRUNED` — `historical state … is not available`: a non-archive
 *   node no longer holds that block's state.
 *
 * Characterized against rpc.testnet.chain.robinhood.com; any other error is
 * `null` and stands as it was answered.
 */
export function pinnedBlockUnavailable(error: string, block: bigint): 'AHEAD_OF_NODE' | 'STATE_PRUNED' | null {
  const ahead = /^RPC_-32000:unsupported block number (\d+)$/.exec(error);
  if (ahead !== null && BigInt(ahead[1] as string) === block) return 'AHEAD_OF_NODE';
  if (/^RPC_-32000:historical state (?:0x)?[0-9a-f]+ is not available$/i.test(error)) return 'STATE_PRUNED';
  return null;
}
