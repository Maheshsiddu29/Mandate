/** A seeded PRNG (xorshift128+ over bigints): deterministic property tests, no `Math.random`. */

export class Rng {
  #a: bigint;
  #b: bigint;

  constructor(seed: number) {
    this.#a = BigInt(seed) * 0x9e3779b97f4a7c15n + 1n;
    this.#b = (BigInt(seed) ^ 0x5deece66dn) * 0xbf58476d1ce4e5b9n + 7n;
    for (let i = 0; i < 16; i += 1) this.next();
  }

  next(): bigint {
    const mask = (1n << 64n) - 1n;
    let x = this.#a;
    const y = this.#b;
    this.#a = y;
    x ^= (x << 23n) & mask;
    this.#b = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return (this.#b + y) & mask;
  }

  int(n: number): number {
    return Number(this.next() % BigInt(n));
  }

  bool(p = 0.5): boolean {
    return this.int(1_000_000) < p * 1_000_000;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)] as T;
  }

  subset<T>(xs: readonly T[], p = 0.5): T[] {
    return xs.filter(() => this.bool(p));
  }
}
