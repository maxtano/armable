/**
 * The only source of randomness in the harness. Seeded, splittable, and free of
 * wall-clock reads, because every test in the simulation matrix depends on a run
 * being reproducible from its seed alone.
 *
 * Streams are *named*, not ordered: `rng.fork('nest-latency')` derives an
 * independent generator from the run seed and the label. Adding a new consumer
 * therefore cannot shift the numbers an existing consumer sees, which is what
 * makes a committed trace digest survive ordinary maintenance.
 */

/** cyrb128: string -> four 32-bit words, for seeding sfc32. */
function seedWords(seed: string): [number, number, number, number] {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  return [
    Math.imul(h3 ^ (h1 >>> 18), 597399067) >>> 0 || 1,
    Math.imul(h4 ^ (h2 >>> 22), 2869860233) >>> 0 || 2,
    Math.imul(h1 ^ (h3 >>> 17), 951274213) >>> 0 || 3,
    Math.imul(h2 ^ (h4 >>> 19), 2716044179) >>> 0 || 4,
  ];
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private draws = 0;
  constructor(readonly seed: string) {
    [this.a, this.b, this.c, this.d] = seedWords(seed);
    // Discard the first few outputs so short, similar seeds do not correlate.
    for (let i = 0; i < 12; i++) this.next();
    this.draws = 0;
  }
  /** An independent stream named by label. Order of creation does not matter. */
  fork(label: string): Rng {
    return new Rng(`${this.seed}::${label}`);
  }
  /** Uniform in [0, 1). sfc32. */
  next(): number {
    this.draws++;
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const u = (t + this.d) | 0;
    this.c = (this.c + u) | 0;
    return (u >>> 0) / 4294967296;
  }
  /** How many values this stream has produced. Recorded in the report as a tripwire. */
  get count(): number {
    return this.draws;
  }
  uniform(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** Standard normal, Box-Muller. The unused second value is discarded rather than
   *  cached, so a stream's n-th draw never depends on how it was consumed before. */
  normal(mean = 0, sd = 1): number {
    const u = Math.max(this.next(), Number.MIN_VALUE);
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  /** Log-normal with the given median. Used for latencies: positive, right-tailed. */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(this.normal(0, sigma));
  }
  /** A point uniformly inside a sphere of the given radius. Position error, not physics. */
  insideSphere(radius: number): [number, number, number] {
    const u = this.next(),
      cosTheta = 2 * this.next() - 1,
      phi = 2 * Math.PI * this.next();
    const r = radius * Math.cbrt(u),
      sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    return [r * sinTheta * Math.cos(phi), r * sinTheta * Math.sin(phi), r * cosTheta];
  }
  bernoulli(p: number): boolean {
    return this.next() < p;
  }
}
