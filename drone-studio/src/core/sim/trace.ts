/**
 * The trace is the artifact: same seed in, identical trace out, on any machine.
 *
 * Every number is quantised to an integer before it is written, so nothing here
 * depends on floating-point *formatting* -- only on the arithmetic, which IEEE
 * 754 pins down. There is no timestamp in a trace line, because a wall-clock
 * read would make the artifact unreproducible by construction.
 */

export const TRACE_FORMAT = 'armable-show-sim-trace/1';

/** Millimetres, as an integer. Readable, and byte-stable across machines. */
export const mm = (metres: number): number => Math.round(metres * 1000);
/** Milliseconds of airborne endurance, as an integer. */
export const ms = (seconds: number): number => Math.round(seconds * 1000);

export class Trace {
  private readonly lines: string[] = [];
  private rows = 0;
  constructor(readonly traceEvery: number) {}

  comment(text: string) {
    this.lines.push(`# ${text}`);
  }
  /** A fixed-field line. Field order is the caller's and never a map's. */
  row(kind: string, fields: readonly (string | number)[]) {
    this.lines.push(`${kind}\t${fields.join('\t')}`);
    this.rows++;
  }
  get rowCount(): number {
    return this.rows;
  }
  get lineCount(): number {
    return this.lines.length;
  }
  text(): string {
    return this.lines.join('\n') + '\n';
  }
  digest(): string {
    return digest(this.text());
  }
}

/**
 * Four FNV-1a lanes with distinct offsets, concatenated: a 128-bit content
 * reference for a trace. Not a cryptographic hash and not claimed to be one --
 * it is a replay reference, and the trace itself is the evidence.
 */
export function digest(text: string): string {
  const offsets = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  const lanes = offsets.slice();
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    for (let lane = 0; lane < 4; lane++) {
      lanes[lane] = Math.imul(lanes[lane] ^ (c + lane), 16777619) >>> 0;
      lanes[lane] = (lanes[lane] ^ (lanes[lane] >>> 13)) >>> 0;
    }
  }
  return lanes.map((l) => (l >>> 0).toString(16).padStart(8, '0')).join('');
}
