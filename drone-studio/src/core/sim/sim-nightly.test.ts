import { describe, expect, it, vi } from 'vitest';
import { runShowSimulation } from './harness';

// These runs are seconds, not milliseconds: an hour-long show at 10 Hz is
// millions of drone-state updates. The default per-test timeout is for unit
// tests and does not apply here.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The nightly rows of the matrix: 200 and 1,000 aircraft.
 *
 * An hour-long 50-drone show at 10 Hz is about 1.8 M drone-state updates and
 * belongs in the per-commit gate. At 1,000 it is ~36 M and does not, so this
 * file is skipped unless `NIGHTLY=1`.
 *
 * Each fleet size is run twice, because the two runs answer different questions.
 * The **single-pack** run asks whether the engine's decisions hold at scale:
 * spacing, containment, the audio lock, the mass launch. The **hour-long**
 * rotated run asks whether the ground system can sustain the fleet for an hour,
 * and at these sizes the answer is no -- the ingress design buys throughput with
 * altitude, and the stack does not fit under a sane ceiling. The engine refusing
 * to compose is the finding, and it is asserted rather than worked around.
 */

const nightly = process.env.NIGHTLY === '1';

describe.skipIf(!nightly)('nightly: the engine at scale', () => {
  it.each([200, 1000])(
    'flies a single-pack show with %i aircraft, cleanly',
    (airborne) => {
      const run = runShowSimulation({
        airborne,
        showSeconds: 600,
        // A pack that outlives the show: this run is about the engine's decisions
        // at scale, not about the nest.
        airSecondsOverride: 1200,
        seed: `nightly-single-${airborne}`,
        label: `single-pack show, ${airborne} drones`,
        sampleEveryTicks: 5,
        traceEvery: 50,
      });
      const r = run.report;
      expect(r.composability.composable).toBe(true);
      expect(r.composability.warnings.join(' ')).toContain('fits inside one pack');
      expect(r.separation.breaches).toBe(0);
      expect(r.separation.descentConflicts).toBe(0);
      expect(r.reserve.breaches).toBe(0);
      expect(r.containment.breaches).toBe(0);
      expect(r.contractViolations).toEqual([]);
      expect(r.audio.locked).toBe(true);
      expect(r.separation.minimumAchieved).toBeGreaterThan(r.separation.truthFloor);
      expect(r.handover.slotFillRate).toBeGreaterThan(0.9);
      expect(r.verdict === 'pass' || r.verdict === 'degraded').toBe(true);
      expect(r.scale.droneStateUpdates).toBeGreaterThan(airborne * 6000);
      // Composition at this fleet size drops more shapes than at 50: `formation()`
      // packs drones closer as the count rises, and some shapes cannot be scaled
      // into compliance within a field.
      expect(r.inputs.show.composition.rejectedShapes.length).toBeGreaterThanOrEqual(4);
      expect(r.inputs.show.composition.worstFormationSeparation).toBeGreaterThanOrEqual(
        r.inputs.show.composition.commandedSpacing
      );
    },
    240_000
  );

  it.each([200, 1000])(
    'refuses to compose an hour-long rotated show with %i aircraft, and shows the arithmetic',
    (airborne) => {
      const run = runShowSimulation({
        airborne,
        seed: `nightly-hour-${airborne}`,
        label: `hour-long show, ${airborne} drones`,
        sampleEveryTicks: 5,
        traceEvery: 50,
      });
      const r = run.report;
      expect(r.verdict).toBe('refused-to-compose');
      expect(r.composability.composable).toBe(false);
      const reasons = r.composability.reasons.join(' ');
      // The binding constraint is altitude, not pads: every transit band costs
      // `transitLaneSpacing` metres and the rotation needs one band per
      // band-hold's worth of traffic, so the stack grows with the fleet until the
      // choreography has nowhere left to be.
      expect(reasons).toMatch(/above the .* Flight Area ceiling|Transit capacity/);
      expect(reasons).toMatch(/\d/);
      expect(r.inputs.engine.transitBands).toBeGreaterThan(8);
      expect(r.inputs.show.minAltitude).toBeGreaterThan(r.inputs.geofence[0].ceiling / 2);
      // Nothing flew: it refused before the first tick.
      expect(r.separation.samples).toBe(0);
      expect(r.rotation.accepted).toBe(0);
    },
    240_000
  );

  it('stays deterministic at 1,000 aircraft', () => {
    const options = {
      airborne: 1000,
      showSeconds: 120,
      airSecondsOverride: 1200,
      seed: 'nightly-determinism-1000',
      sampleEveryTicks: 5,
      traceEvery: 50,
    } as const;
    const first = runShowSimulation(options);
    const second = runShowSimulation({ ...options, insertionOrder: 'reversed' });
    expect(second.trace).toBe(first.trace);
    expect(second.report.determinism.traceDigest).toBe(first.report.determinism.traceDigest);
  }, 240_000);
});
