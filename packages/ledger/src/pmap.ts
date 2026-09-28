/**
 * A persistent (immutable, structurally shared) string-keyed map.
 *
 * The ledger's derived state must be immutable — a snapshot read at version
 * `v` stays exactly version `v` while later batches commit — and a commit must
 * not copy the whole state, or every authorization would cost O(history).
 * This is a hash array mapped trie: `set` copies only the path from the root
 * to the changed entry (at most seven 32-way nodes), so a commit that touches
 * a handful of balances and one reservation is O(log n) and every older
 * snapshot keeps sharing the untouched structure.
 *
 * There is no delete: the ledger is append-only, and nothing it records is
 * ever removed (a closed reservation, a revoked node and a replaced policy's
 * dimension all remain). Iteration order is the hash order; anything that
 * needs a canonical order sorts the keys.
 */

type Leaf<V> = { readonly t: 0; readonly hash: number; readonly key: string; readonly value: V };
type Collision<V> = { readonly t: 1; readonly hash: number; readonly leaves: readonly Leaf<V>[] };
type Branch<V> = { readonly t: 2; readonly bitmap: number; readonly children: readonly TrieNode<V>[] };
type TrieNode<V> = Leaf<V> | Collision<V> | Branch<V>;

const BITS = 5;
const MASK = 31;

/** FNV-1a over UTF-16 code units, as an unsigned 32-bit integer. */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function popcount(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function chunk(hash: number, shift: number): number {
  return (hash >>> shift) & MASK;
}

/** Two nodes with different hashes, merged under a branch at `shift`. */
function merge<V>(shift: number, a: Leaf<V> | Collision<V>, b: Leaf<V>): Branch<V> {
  const ia = chunk(a.hash, shift);
  const ib = chunk(b.hash, shift);
  if (ia === ib) return { t: 2, bitmap: 1 << ia, children: [merge(shift + BITS, a, b)] };
  return { t: 2, bitmap: (1 << ia) | (1 << ib), children: ia < ib ? [a, b] : [b, a] };
}

/** Returns the new node and whether a key was added (rather than replaced). */
function insert<V>(node: TrieNode<V> | undefined, shift: number, leaf: Leaf<V>): { node: TrieNode<V>; added: boolean } {
  if (node === undefined) return { node: leaf, added: true };
  switch (node.t) {
    case 0:
      if (node.key === leaf.key) return { node: leaf, added: false };
      if (node.hash === leaf.hash) return { node: { t: 1, hash: leaf.hash, leaves: [node, leaf] }, added: true };
      return { node: merge(shift, node, leaf), added: true };
    case 1: {
      if (node.hash !== leaf.hash) return { node: merge(shift, node, leaf), added: true };
      const i = node.leaves.findIndex((l) => l.key === leaf.key);
      if (i < 0) return { node: { t: 1, hash: node.hash, leaves: [...node.leaves, leaf] }, added: true };
      const leaves = node.leaves.slice();
      leaves[i] = leaf;
      return { node: { t: 1, hash: node.hash, leaves }, added: false };
    }
    case 2: {
      const bit = 1 << chunk(leaf.hash, shift);
      const pos = popcount(node.bitmap & (bit - 1));
      const children = node.children.slice();
      if ((node.bitmap & bit) === 0) {
        children.splice(pos, 0, leaf);
        return { node: { t: 2, bitmap: node.bitmap | bit, children }, added: true };
      }
      const r = insert(children[pos], shift + BITS, leaf);
      children[pos] = r.node;
      return { node: { t: 2, bitmap: node.bitmap, children }, added: r.added };
    }
  }
}

function lookup<V>(node: TrieNode<V> | undefined, hash: number, key: string): V | undefined {
  let shift = 0;
  let current = node;
  while (current !== undefined) {
    switch (current.t) {
      case 0:
        return current.key === key ? current.value : undefined;
      case 1:
        return current.hash === hash ? current.leaves.find((l) => l.key === key)?.value : undefined;
      case 2: {
        const bit = 1 << chunk(hash, shift);
        if ((current.bitmap & bit) === 0) return undefined;
        current = current.children[popcount(current.bitmap & (bit - 1))];
        shift += BITS;
        break;
      }
    }
  }
  return undefined;
}

function* walk<V>(node: TrieNode<V> | undefined): Generator<[string, V]> {
  if (node === undefined) return;
  switch (node.t) {
    case 0:
      yield [node.key, node.value];
      return;
    case 1:
      for (const l of node.leaves) yield [l.key, l.value];
      return;
    case 2:
      for (const c of node.children) yield* walk(c);
      return;
  }
}

export class PMap<V> {
  readonly #root: TrieNode<V> | undefined;
  readonly size: number;

  private constructor(root: TrieNode<V> | undefined, size: number) {
    this.#root = root;
    this.size = size;
  }

  static empty<V>(): PMap<V> {
    return new PMap<V>(undefined, 0);
  }

  get(key: string): V | undefined {
    return lookup(this.#root, hashKey(key), key);
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** A new map with `key` set; this map is unchanged. */
  set(key: string, value: V): PMap<V> {
    const r = insert(this.#root, 0, { t: 0, hash: hashKey(key), key, value });
    return new PMap(r.node, r.added ? this.size + 1 : this.size);
  }

  entries(): Generator<[string, V]> {
    return walk(this.#root);
  }

  values(): V[] {
    const out: V[] = [];
    for (const [, v] of walk(this.#root)) out.push(v);
    return out;
  }

  /** Keys in ascending code-unit order: the canonical order for encodings. */
  sortedKeys(): string[] {
    const keys: string[] = [];
    for (const [k] of walk(this.#root)) keys.push(k);
    return keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}
