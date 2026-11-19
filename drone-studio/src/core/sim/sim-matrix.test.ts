import { describe, expect, it, vi } from 'vitest';
import { droneStates, geofenceZones, type AbortMode, type DroneState } from './contracts';
import { buildSimulation, runShowSimulation, type SimulationRun } from './harness';
import { buildShowPlan, TICK_HZ, TICK_SECONDS } from './show-plan';
import { validateProject } from '../validation';

// These runs are seconds, not milliseconds: an hour-long show at 10 Hz is
// millions of drone-state updates. The default per-test timeout is for unit
// tests and does not apply here.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The per-commit matrix from the program hub's `arms/show/simulation-spec.md`.
 *
 * The headline test is an hour-long show at 50 drones, and the spec is explicit
 * that it has to stay in the inner loop: if this file stops finishing inside two
 * minutes the fix is the harness, not the drone count.
 */

const HOUR = 3600;
let hourRun: SimulationRun | null = null;
/** One hour-long run, shared. Several rows of the matrix read the same show. */
const hour = (): SimulationRun => (hourRun ??= runShowSimulation({ seed: 'armable-g1-0001' }));

describe('hour-long show, 50 drones', () => {
  it('flies an hour with zero collisions and zero reserve violations', () => {
    const run = hour();
    const r = run.report;
    expect(r.inputs.show.durationSeconds).toBe(HOUR);
    expect(r.inputs.show.droneCount).toBe(50);
    expect(r.scale.ticks).toBe(HOUR * TICK_HZ);
    // ~1.8 M drone-state updates at 50 airborne; more, because the roster that
    // keeps 50 airborne for an hour is larger than 50.
    expect(r.scale.droneStateUpdates).toBeGreaterThan(1_800_000);

    expect(r.separation.breaches).toBe(0);
    expect(r.reserve.breaches).toBe(0);
    expect(r.containment.breaches).toBe(0);
    expect(r.contractViolations).toEqual([]);
    expect(r.losses.total).toBe(0);
    expect(r.abort).toBeNull();
    expect(r.verdict).toBe('pass');

    // Margins, not a pass. The minimum achieved is above the floor the commanded
    // gap guarantees, and the lowest reserve margin is above zero.
    expect(r.separation.minimumAchieved).toBeGreaterThan(r.separation.truthFloor);
    expect(r.separation.margin).toBeGreaterThan(0);
    expect(r.separation.minimumAchieved).toBeGreaterThan(r.separation.collisionThreshold * 4);
    expect(r.reserve.lowestMarginSeconds).toBeGreaterThan(0);
    // And the show was actually flown, rather than refusing early and passing.
    expect(r.handover.slotFillRate).toBeGreaterThan(0.8);
    expect(r.rotation.swapsCompleted).toBeGreaterThan(100);
  });

  it('composes only against a nest that can turn the fleet around', () => {
    const c = hour().report.composability;
    expect(c.composable).toBe(true);
    expect(c.rotationDemandPerMinute).toBeLessThan(c.rotationCapacityPerMinute);
    expect(c.rotationDemandPerMinute).toBeLessThan(c.transitCapacityPerMinute);
    expect(c.rosterRequired).toBeLessThanOrEqual(c.rosterAvailable);
  });

  it('composes a show whose own geometry leaves room to fly and to rotate', () => {
    const composition = hour().report.inputs.show.composition;
    // `formation()` does not guarantee the project's minimum separation, and a
    // formation with an aircraft directly under another cannot be rotated. Both
    // are composition properties, so the plan builder checks and rejects.
    expect(composition.worstFormationSeparation).toBeGreaterThanOrEqual(
      composition.commandedSpacing
    );
    expect(composition.worstTransitionSeparation).toBeGreaterThanOrEqual(
      composition.commandedSpacing
    );
    expect(composition.rejectedShapes.length).toBeGreaterThan(0);
    expect(composition.rejectedShapes.join(' ')).toMatch(/ingress corridor|scale/);
    expect(composition.usedShapes.length).toBeGreaterThan(1);
  });

  it("passes the engine's own design review, not just the harness's", () => {
    // The show the harness flies is composed to live inside the limits the
    // project declares, so `validateProject()` -- the check a choreographer sees
    // in the studio -- has nothing to fail it on.
    const plan = buildShowPlan({
      droneCount: 50,
      showSeconds: 3600,
      commandedSpacing: hour().report.inputs.show.composition.commandedSpacing,
      floor: hour().report.inputs.show.minAltitude,
      ceiling: 200,
    });
    for (const segment of plan.segments) {
      const review = validateProject(segment);
      expect(review.conflicts, `${segment.id} separation`).toEqual([]);
      expect(review.checks.filter((c) => c.status === 'fail')).toEqual([]);
      expect(review.maxSpeed).toBeLessThanOrEqual(segment.limits.maxSpeed);
      expect(review.maxAcceleration).toBeLessThanOrEqual(segment.limits.maxAcceleration);
      expect(review.maxAltitude).toBeLessThanOrEqual(segment.limits.maxAltitude);
      expect(review.minAltitude).toBeGreaterThan(0);
    }
  });
});

describe('determinism', () => {
  it('produces a byte-identical trace from the same seed', () => {
    const first = hour();
    const second = runShowSimulation({ seed: 'armable-g1-0001' });
    expect(second.trace).toBe(first.trace);
    expect(second.report.determinism.traceDigest).toBe(first.report.determinism.traceDigest);
    expect(second.report.determinism.reportDigest).toBe(first.report.determinism.reportDigest);
    expect(second.report.determinism.rngDraws).toBe(first.report.determinism.rngDraws);
    expect(second.trace.length).toBeGreaterThan(10_000);
  });

  it('does not depend on the order collections were built in', () => {
    // Nothing may rely on map or set iteration order. Building the roster and the
    // pad list backwards is the cheapest way to find out whether anything does.
    const reversed = runShowSimulation({ seed: 'armable-g1-0001', insertionOrder: 'reversed' });
    const forward = hour();
    expect(reversed.trace).toBe(forward.trace);
    expect(reversed.report.determinism.traceDigest).toBe(forward.report.determinism.traceDigest);
    expect(reversed.report.determinism.insertionOrder).toBe('reversed');
    expect(forward.report.determinism.insertionOrder).toBe('natural');
  });

  it('diverges on a different seed, so the match above means something', () => {
    const other = runShowSimulation({ seed: 'armable-g1-0002', showSeconds: 600 });
    const same = runShowSimulation({ seed: 'armable-g1-0001', showSeconds: 600 });
    expect(other.trace).not.toBe(same.trace);
    expect(other.report.determinism.traceDigest).not.toBe(same.report.determinism.traceDigest);
  });
});

describe('geofence containment, four zones', () => {
  it('keeps every aircraft inside all four zones for the whole show', () => {
    const r = hour().report;
    expect(r.containment.margins.map((m) => m.zone)).toEqual([...geofenceZones]);
    for (const margin of r.containment.margins) {
      expect(margin.horizontal, `${margin.zone} horizontal`).toBeGreaterThan(0);
      expect(margin.vertical, `${margin.zone} vertical`).toBeGreaterThan(0);
      expect(margin.atTick).toBeGreaterThanOrEqual(0);
    }
    expect(r.containment.breaches).toBe(0);
    // Each zone is strictly larger than the one inside it.
    const radii = r.containment.margins.map((m) => m.zoneRadius);
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
    expect(new Set(radii).size).toBe(4);
  });

  it('scales the restricted area with show altitude', () => {
    const low = runShowSimulation({
      showSeconds: 600,
      label: 'low show',
      engine: { transitBaseAltitude: 8, transitLaneSpacing: 3.5 },
    }).report.containment;
    const high = hour().report.containment;
    expect(high.impliedByAltitude).toBeGreaterThan(low.impliedByAltitude);
    expect(high.restrictedArea.waiverRuleMetres).toBeGreaterThan(
      low.restrictedArea.waiverRuleMetres
    );
    expect(high.restrictedArea.metres).toBeGreaterThan(low.restrictedArea.metres);
    // The hard fence stops the motors, so containment past it is ballistic. At
    // show altitudes the ballistic throw is the binding figure, not the waiver's
    // +10 m per 100 ft rule -- which is the point of modelling both.
    expect(high.restrictedArea.binding).toBe('ballistic');
    expect(high.restrictedArea.metres).toBe(high.restrictedArea.ballisticMetres);
    const zones = hour().report.inputs.geofence;
    expect(zones.find((z) => z.zone === 'hard-fence')!.behaviourOnViolation).toContain(
      'motors stop'
    );
    expect(zones.find((z) => z.zone === 'soft-fence')!.behaviourOnViolation).toMatch(/autoland/);
  });
});

describe('music and motion stay locked across the full hour', () => {
  it('holds every cue boundary on the beat and every tick on the audio clock', () => {
    const audio = hour().report.audio;
    expect(audio.locked).toBe(true);
    expect(audio.beatsPlayed).toBe(7200);
    expect(audio.maxCueBoundaryBeatError).toBeLessThan(1e-9);
    expect(audio.maxMotionAudioOffsetSeconds).toBeLessThan(1e-9);
  });
});

describe('rotation at and beyond nest capacity', () => {
  it('composes and flies at 100% of rotation_capacity', () => {
    const run = runShowSimulation({
      seed: 'armable-g1-at-capacity',
      label: 'rotation at 100% of capacity',
      targetUtilisation: 1,
      showSeconds: 1800,
    });
    const r = run.report;
    expect(r.composability.composable).toBe(true);
    expect(r.rotation.utilisation).toBeGreaterThan(0.97);
    expect(r.rotation.utilisation).toBeLessThanOrEqual(1.0001);
    expect(r.composability.warnings.join(' ')).toMatch(/no margin/);
    // At capacity there is no slack for a late pad, so refusals and holds are
    // expected. Running out of reserve or into another aircraft is not.
    expect(r.separation.breaches).toBe(0);
    expect(r.reserve.breaches).toBe(0);
    expect(r.rotation.swapsCompleted).toBeGreaterThan(40);
  });

  it('refuses to compose at 120%, and says why in numbers', () => {
    const run = runShowSimulation({
      seed: 'armable-g1-beyond-capacity',
      label: 'rotation at 120% of capacity',
      targetUtilisation: 1.2,
      showSeconds: 1800,
    });
    const r = run.report;
    expect(r.verdict).toBe('refused-to-compose');
    expect(r.composability.composable).toBe(false);
    expect(r.composability.utilisation).toBeGreaterThan(1);
    expect(r.composability.reasons.join(' ')).toMatch(/exceeds nest capacity|Refusing to compose/);
    expect(r.composability.reasons.join(' ')).toMatch(/\d+\.\d+\/min/);
    // It refused before flying anything: no aircraft went into a dead nest.
    expect(r.rotation.accepted).toBe(0);
    expect(r.separation.samples).toBe(0);
    expect(run.trace).toContain('config');
  });
});

describe('abort from every enumerated state', () => {
  /** Drive a simulation to a chosen tick, then abort and let the fleet settle. */
  function abortAt(
    tick: number,
    mode: AbortMode,
    prepare: (sim: ReturnType<typeof buildSimulation>, tick: number) => void
  ) {
    const sim = buildSimulation({
      seed: `abort-${tick}-${mode}`,
      showSeconds: 900,
      label: `abort ${mode} at tick ${tick}`,
    });
    const { engine, fleet, nest } = sim;
    for (let t = 0; t < tick; t++) {
      engine.step(t);
      engine.releaseClearedPads();
      fleet.advance(t + 1);
      for (const done of nest.advance(t + 1)) engine.swapComplete(done.droneId, done.pad);
    }
    prepare(sim, tick);
    engine.step(tick);
    const before = new Map<number, DroneState>();
    for (let id = 1; id <= fleet.size; id++) before.set(id, fleet.truth(id).state);
    const outcomes = fleet.abort(mode);
    // Let it settle: a land-in-place has to actually reach the ground.
    for (let t = tick; t < tick + 1200; t++) fleet.advance(t + 1);
    return { sim, outcomes, before };
  }

  const moments: [string, number][] = [
    // Mid-formation: everyone on station, no cue change nearby.
    ['mid-formation', 900],
    // Mid-transition: inside a 12 s blend between cues.
    ['mid-transition', 1255],
    // Mid-swap: the rotation is running and aircraft are on pads.
    ['mid-swap', 6000],
    // Later still, after the show has had to put an aircraft down out of turn,
    // so an aircraft that landed without a pack swap is in the mix.
    ['after a contingency landing', 12000],
  ];

  it.each(moments)('aborts cleanly %s, from every state present', (name, tick) => {
    for (const mode of ['land-in-place', 'hold-position'] as AbortMode[]) {
      const { sim, outcomes, before } = abortAt(tick, mode, (s, at) => {
        // Partial comms: two aircraft stop reporting just before the abort, so
        // the engine is aborting a fleet it cannot fully see.
        const onStation = s.engine.assignments.filter((a) => a.phase === 'on-station');
        if (onStation[0]) s.fleet.injectSilence(onStation[0].id);
        if (onStation[1]) s.fleet.injectSilence(onStation[1].id);
        // And one is faulted, so an uncommandable aircraft is in the mix.
        if (onStation[2]) s.fleet.injectFault(onStation[2].id);
        expect(at).toBe(tick);
      });
      // Every aircraft in the roster produced exactly one outcome.
      expect(outcomes).toHaveLength(sim.fleet.size);
      expect(new Set(outcomes.map((o) => o.id)).size).toBe(sim.fleet.size);
      for (const outcome of outcomes) {
        expect(droneStates).toContain(outcome.stateBefore);
        expect(outcome.stateBefore).toBe(before.get(outcome.id));
        expect(outcome.mode).toBe(mode);
      }
      // Nothing is left in powered station-keeping flight.
      for (let id = 1; id <= sim.fleet.size; id++) {
        const z = sim.fleet.truePosition(id)[2];
        if (mode === 'land-in-place')
          expect(z, `drone ${id} should be down after ${name}`).toBeLessThan(0.6);
        else expect(z).toBeLessThan(sim.plan.maxAltitude + 1);
      }
      const dispositions = new Set(outcomes.map((o) => o.disposition));
      expect(dispositions.size).toBeGreaterThan(1);
      if (mode === 'land-in-place') expect(dispositions).toContain('landing');
      else expect(dispositions).toContain('holding');
      // A faulted aircraft is reported as not under command rather than as obeying.
      expect([...dispositions]).toContain('uncommanded-descent');
    }
  });

  it('covers every state a running show can produce', () => {
    const seen = new Set<DroneState>();
    for (const [, tick] of moments) {
      const { before } = abortAt(tick, 'land-in-place', (s) => {
        const onStation = s.engine.assignments.filter((a) => a.phase === 'on-station');
        if (onStation[0]) s.fleet.injectFault(onStation[0].id);
        const idle = s.engine.assignments.find((a) => a.phase === 'grid');
        if (idle) s.fleet.markDocked(idle.id, 0);
      });
      for (const state of before.values()) seen.add(state);
    }
    // Five of the six. `docked` does not occur in normal operation of this
    // engine: an aircraft that reaches the ground on a pad is claimed by the nest
    // as `charging` in the same tick, so `docked` is only reported by an aircraft
    // that landed *without* a pack swap. That path is exercised directly in
    // `sim-contracts.test.ts`, which walks all six states, and the abort matrix
    // above covers every state actually present at each moment.
    expect([...seen].sort()).toEqual(['charging', 'fault', 'flying', 'ready', 'returning']);
    expect(droneStates.filter((s) => !seen.has(s))).toEqual(['docked']);
  });
});

describe('the run report is the deliverable, not the pass bit', () => {
  it('states every headline number as a margin against the figure it came from', () => {
    const r = hour().report;
    expect(r.separation.spacingSource).toContain('declared error volume');
    expect(r.separation.truthFloor).toBeLessThan(r.separation.requiredSpacing);
    expect(r.inputs.nest.sizingSource).toContain('show_sizing.py');
    expect(r.limitations.length).toBeGreaterThan(5);
    expect(r.verdictReasons.length).toBeGreaterThan(0);
    expect(r.determinism.traceDigest).toMatch(/^[0-9a-f]{32}$/);
    expect(r.determinism.reportDigest).toMatch(/^[0-9a-f]{32}$/);
    expect(r.determinism.fixedTimestepHz).toBe(TICK_HZ);
    expect(TICK_SECONDS).toBe(0.1);
    // The report carries no wall clock, so two runs of a seed are byte-identical.
    expect(JSON.stringify(r)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});
