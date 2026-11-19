/**
 * Closest-pair measurement, shared by the plan builder and the harness.
 *
 * Deterministic by construction: points are visited in index order, grid cells
 * are keyed by integers and visited at fixed offsets, and cell members stay in
 * insertion order. Nothing here iterates a Map for anything that reaches output.
 */

export type ClosestPair = { distance: number; a: number; b: number };

/** Exact, O(n^2). Used up to `EXACT_LIMIT` points. */
export const EXACT_LIMIT = 256;

export function closestPairExact(
  positions: Float32Array | number[],
  ids?: readonly number[]
): ClosestPair | null {
  const n = Math.floor(positions.length / 3);
  let distance = Infinity,
    a = -1,
    b = -1;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(
        positions[i * 3] - positions[j * 3],
        positions[i * 3 + 1] - positions[j * 3 + 1],
        positions[i * 3 + 2] - positions[j * 3 + 2]
      );
      if (d < distance) {
        distance = d;
        a = i;
        b = j;
      }
    }
  if (a < 0) return null;
  const ia = ids ? ids[a] : a,
    ib = ids ? ids[b] : b;
  return { distance, a: Math.min(ia, ib), b: Math.max(ia, ib) };
}

/** Closest pair within `probe` metres, via a uniform integer-keyed grid. */
export function closestPairGrid(
  positions: Float32Array | number[],
  probe: number,
  ids?: readonly number[]
): ClosestPair | null {
  const n = Math.floor(positions.length / 3);
  const cells = new Map<number, number[]>();
  const cell = (v: number) => Math.floor(v / probe) + 4096;
  const key = (x: number, y: number, z: number) => (cell(x) * 8192 + cell(y)) * 8192 + cell(z);
  for (let i = 0; i < n; i++) {
    const k = key(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    const bucket = cells.get(k);
    if (bucket) bucket.push(i);
    else cells.set(k, [i]);
  }
  let distance = Infinity,
    a = -1,
    b = -1;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = cells.get(
            ((cell(x) + dx) * 8192 + (cell(y) + dy)) * 8192 + (cell(z) + dz)
          );
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const d = Math.hypot(
              x - positions[j * 3],
              y - positions[j * 3 + 1],
              z - positions[j * 3 + 2]
            );
            if (d < distance && d <= probe) {
              distance = d;
              a = i;
              b = j;
            }
          }
        }
  }
  if (a < 0) return null;
  const ia = ids ? ids[a] : a,
    ib = ids ? ids[b] : b;
  return { distance, a: Math.min(ia, ib), b: Math.max(ia, ib) };
}

/** Exact below `EXACT_LIMIT` points, grid-probed above it. */
export function closestPair(
  positions: Float32Array | number[],
  probe: number,
  ids?: readonly number[]
): ClosestPair | null {
  return Math.floor(positions.length / 3) <= EXACT_LIMIT
    ? closestPairExact(positions, ids)
    : closestPairGrid(positions, probe, ids);
}

/**
 * Smallest horizontal gap between any aircraft and one below it.
 *
 * A rotated show has to let aircraft in and out of the formation, and they
 * arrive and leave vertically: the engine lifts a relief up into a slot and
 * lowers the aircraft it replaced back down. So every slot needs a clear
 * vertical corridor beneath it, and a formation where one drone hovers directly
 * under another has no way in or out of the upper one. That is a property of the
 * *choreography*, not of the engine, and it is why the plan builder checks it.
 *
 * Grid-accelerated in the horizontal plane: a drone can only shadow another if
 * it is within `spacing` horizontally, so only neighbouring cells matter.
 */
export function ingressClearance(
  positions: Float32Array | number[],
  spacing: number,
  verticalTolerance = 0.5
): number {
  const n = Math.floor(positions.length / 3);
  const cells = new Map<number, number[]>();
  const cell = (v: number) => Math.floor(v / spacing) + 4096;
  const key = (x: number, y: number) => cell(x) * 8192 + cell(y);
  for (let i = 0; i < n; i++) {
    const k = key(positions[i * 3], positions[i * 3 + 1]);
    const bucket = cells.get(k);
    if (bucket) bucket.push(i);
    else cells.set(k, [i]);
  }
  let worst = Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = cells.get((cell(x) + dx) * 8192 + (cell(y) + dy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j === i) continue;
          if (positions[j * 3 + 2] >= z - verticalTolerance) continue;
          const gap = Math.hypot(x - positions[j * 3], y - positions[j * 3 + 1]);
          if (gap < worst) worst = gap;
        }
      }
  }
  return worst;
}
