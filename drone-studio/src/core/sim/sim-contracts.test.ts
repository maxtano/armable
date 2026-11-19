import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { droneStates, padStates, type AbortMode, type DroneState } from './contracts';
import { FakeFleet, type FakeFleetConfig } from './fake-fleet';
import { FakeNest, type FakeNestConfig } from './fake-nest';
import { defaultSizingInputs, sizeGroundSystem } from './nest-sizing';
import { Rng } from './rng';
import { TICK_HZ } from './show-plan';
import { restrictedAreaWidth } from './geofence';

const fleetConfig = (overrides: Partial<FakeFleetConfig> = {}): FakeFleetConfig => ({
  size: 4,
  declaredErrorVolume: 0.1,
  deliveredErrorVolume: 0.1,
  airSeconds: 300,
  reserveSeconds: 60,
  maxSimultaneousLoss: 2,
  homePositions: [
    [0, 0, 0],
    [10, 0, 0],
    [20, 0, 0],
    [30, 0, 0],
  ],
  descentSpeed: 2.5,
  errorRefreshTicks: 10,
  ...overrides,
});

const nestConfig = (overrides: Partial<FakeNestConfig> = {}): FakeNestConfig => ({
  pads: 2,
  modules: 1,
  packSlotsPerModule: 20,
  dockToReadyMedianTicks: 450,
  dockToReadySigma: 0.2,
  requiredNoticeTicks: 450,
  packTurnaroundTicks: 19800,
  initialChargedPacks: 20,
  padPositions: [
    [0, -60, 0],
    [6, -60, 0],
  ],
  corridorRadius: 3,
  corridorClearTicks: 40,
  noShowTicks: 600,
  ...overrides,
});

/** Fly a drone to altitude so it is genuinely airborne. */
function launch(fleet: FakeFleet, id: number, from: number, to = 50) {
  for (let tick = from; tick < from + 60; tick++) {
    fleet.ingestTrajectory(id, [{ time: (tick + 1) / TICK_HZ, position: [0, 0, to] }], 'launch');
    fleet.advance(tick + 1);
  }
  return from + 60;
}

describe('contract 1: the fake fleet', () => {
  it('declares an error volume the engine can compute spacing from, and can under-deliver on purpose', () => {
    const fleet = new FakeFleet(
      fleetConfig({ declaredErrorVolume: 0.1, deliveredErrorVolume: 0.4 }),
      new Rng('errors')
    );
    expect(fleet.declaredErrorVolume).toBe(0.1);
    const tick = launch(fleet, 1, 0);
    const report = fleet.telemetry(1)!;
    // It still claims the declared figure. That is the failure contract 1 warns about.
    expect(report.reportedAccuracy).toBe(0.1);
    const nominal = fleet.nominalPosition(1);
    const truth = fleet.truePosition(1);
    const delivered = Math.hypot(
      truth[0] - nominal[0],
      truth[1] - nominal[1],
      truth[2] - nominal[2]
    );
    expect(delivered).toBeGreaterThan(0.1);
    expect(delivered).toBeLessThanOrEqual(0.4);
    expect(tick).toBeGreaterThan(0);
  });

  it('reports energy in usable airborne seconds, which only run down in flight', () => {
    const fleet = new FakeFleet(fleetConfig(), new Rng('energy'));
    expect(fleet.telemetry(1)!.energyRemaining).toBe(300);
    for (let tick = 0; tick < 50; tick++) fleet.advance(tick + 1);
    // Parked on the launch grid: a drone on the ground spends nothing.
    expect(fleet.telemetry(1)!.energyRemaining).toBe(300);
    launch(fleet, 1, 50);
    const spent = 300 - fleet.telemetry(1)!.energyRemaining;
    expect(spent).toBeGreaterThan(4);
    expect(spent).toBeLessThan(6.1);
  });

  it('accepts timestamped trajectory and light keyframes, and can refuse both', () => {
    const fleet = new FakeFleet(fleetConfig(), new Rng('ingest'));
    expect(fleet.ingestTrajectory(1, [{ time: 1, position: [1, 2, 3] }], 'launch')).toBe(true);
    expect(fleet.ingestLights(1, [{ time: 1, rgb: [1, 1, 1], brightness: 1 }])).toBe(true);
    fleet.injectCommandRefusal(1, 100);
    expect(fleet.ingestTrajectory(1, [{ time: 2, position: [1, 2, 3] }], 'station')).toBe(false);
    expect(fleet.ingestLights(1, [{ time: 2, rgb: [1, 1, 1], brightness: 1 }])).toBe(false);
    // A refusal is per drone, not fleet-wide.
    expect(fleet.ingestTrajectory(2, [{ time: 2, position: [0, 0, 1] }], 'station')).toBe(true);
  });

  it('reports every state in the enum and nothing outside it', () => {
    const fleet = new FakeFleet(
      fleetConfig({
        size: 6,
        homePositions: Array.from(
          { length: 6 },
          (_, i) => [i * 10, 0, 0] as [number, number, number]
        ),
      }),
      new Rng('states')
    );
    const states = new Set<DroneState>();
    states.add(fleet.telemetry(1)!.state); // ready
    launch(fleet, 2, 0);
    states.add(fleet.telemetry(2)!.state); // flying
    fleet.ingestTrajectory(3, [{ time: 1, position: [0, 0, 40] }], 'launch');
    fleet.advance(70);
    for (let tick = 70; tick < 130; tick++) {
      fleet.ingestTrajectory(3, [{ time: (tick + 1) / TICK_HZ, position: [0, 0, 40] }], 'launch');
      fleet.advance(tick + 1);
    }
    fleet.ingestTrajectory(3, [{ time: 14, position: [0, 0, 40] }], 'return');
    fleet.advance(131);
    states.add(fleet.telemetry(3)!.state); // returning
    for (let tick = 131; tick < 300; tick++) {
      fleet.ingestTrajectory(3, [{ time: (tick + 1) / TICK_HZ, position: [0, 0, 0] }], 'return');
      fleet.advance(tick + 1);
    }
    states.add(fleet.telemetry(3)!.state); // docked
    fleet.markDocked(4, 0);
    fleet.advance(301);
    states.add(fleet.telemetry(4)!.state); // charging
    fleet.injectFault(5);
    fleet.advance(302);
    states.add(fleet.telemetry(5)!.state); // fault
    expect([...states].sort()).toEqual([...droneStates].sort());
  });

  it('treats silence as silence: the last report keeps its old tick', () => {
    const fleet = new FakeFleet(fleetConfig(), new Rng('silence'));
    const tick = launch(fleet, 1, 0);
    fleet.injectSilence(1);
    const atSilence = fleet.telemetry(1)!;
    for (let t = tick; t < tick + 100; t++) {
      fleet.ingestTrajectory(1, [{ time: (t + 1) / TICK_HZ, position: [40, 0, 50] }], 'station');
      fleet.advance(t + 1);
    }
    const later = fleet.telemetry(1)!;
    expect(later.tick).toBe(atSilence.tick);
    // It kept flying: a drone that stopped talking did not stop moving.
    expect(fleet.truePosition(1)[0]).toBeGreaterThan(5);
  });

  it.each(droneStates)('honors an abort from state %s, in both modes', (state) => {
    for (const mode of ['land-in-place', 'hold-position'] as AbortMode[]) {
      const fleet = new FakeFleet(fleetConfig(), new Rng(`abort-${state}-${mode}`));
      let tick = 0;
      if (state === 'flying') tick = launch(fleet, 1, 0);
      else if (state === 'returning') {
        tick = launch(fleet, 1, 0);
        fleet.ingestTrajectory(1, [{ time: tick / TICK_HZ + 1, position: [0, 0, 50] }], 'return');
        fleet.advance(++tick);
      } else if (state === 'docked') {
        tick = launch(fleet, 1, 0);
        for (let t = tick; t < tick + 300; t++) {
          fleet.ingestTrajectory(1, [{ time: (t + 1) / TICK_HZ, position: [0, 0, 0] }], 'return');
          fleet.advance(t + 1);
        }
        tick += 300;
      } else if (state === 'charging') fleet.markDocked(1, 0);
      else if (state === 'fault') {
        tick = launch(fleet, 1, 0);
        fleet.injectFault(1);
      }
      fleet.advance(++tick);
      expect(fleet.telemetry(1)!.state).toBe(state);
      const outcomes = fleet.abort(mode);
      // Every aircraft in the roster produces exactly one outcome. There is no
      // refusal path: that is what "non-negotiable" means in contract 1.
      expect(outcomes).toHaveLength(fleet.size);
      expect(outcomes.filter((o) => o.id === 1)).toHaveLength(1);
      const outcome = outcomes.find((o) => o.id === 1)!;
      expect(outcome.stateBefore).toBe(state);
      expect(outcome.note.length).toBeGreaterThan(10);
      if (state === 'fault') expect(outcome.disposition).toBe('uncommanded-descent');
      else if (state === 'flying' || state === 'returning')
        expect(outcome.disposition).toBe(mode === 'land-in-place' ? 'landing' : 'holding');
      else expect(outcome.disposition).toBe('already-on-ground');
      // And it is obeyed: nothing keeps station-keeping after a land-in-place,
      // and a hold really holds -- except for a faulted aircraft, which is coming
      // down under its own failsafe and is not obeying anything.
      const before = fleet.truePosition(1)[2];
      for (let t = tick; t < tick + 40; t++) fleet.advance(t + 1);
      const after = fleet.truePosition(1)[2];
      if (state === 'fault') expect(after).toBeLessThan(before);
      else if (mode === 'land-in-place') expect(after).toBeLessThanOrEqual(before);
      else expect(Math.abs(after - before)).toBeLessThan(0.3);
    }
  });
});

describe('contract 2: the fake nest', () => {
  it('quotes a rotation capacity that includes the corridor, not just the swap', () => {
    const nest = new FakeNest(nestConfig(), new Rng('capacity'));
    // Two pads, 45 s swap plus 4 s corridor: 2 / 49 s, per minute.
    expect(nest.rotationCapacityPerMinute).toBeCloseTo((2 * 60) / 49, 3);
    expect(nest.rotationCapacityPerModulePerMinute).toBeCloseTo((2 * 60) / 49, 3);
  });

  it('refuses explicitly, with a reason, in every way it can', () => {
    const nest = new FakeNest(nestConfig(), new Rng('refusals'));
    expect(nest.requestDock({ droneId: 1, arrivalTick: 10, noticeTicks: 10 })).toEqual({
      accepted: false,
      reason: 'insufficient-notice',
    });
    const first = nest.requestDock({ droneId: 1, arrivalTick: 450, noticeTicks: 450 });
    const second = nest.requestDock({ droneId: 2, arrivalTick: 450, noticeTicks: 450 });
    expect(first.accepted && second.accepted).toBe(true);
    // Both pads are booked for that arrival, so a third is refused rather than
    // quietly queued behind them.
    expect(nest.requestDock({ droneId: 3, arrivalTick: 450, noticeTicks: 450 })).toEqual({
      accepted: false,
      reason: 'no-free-pad',
    });
    const starved = new FakeNest(nestConfig({ initialChargedPacks: 0 }), new Rng('starved'));
    expect(starved.requestDock({ droneId: 1, arrivalTick: 450, noticeTicks: 450 })).toEqual({
      accepted: false,
      reason: 'no-charged-pack',
    });
    const broken = new FakeNest(nestConfig(), new Rng('broken'));
    broken.injectPadFault(0);
    broken.injectPadFault(1);
    expect(broken.requestDock({ droneId: 1, arrivalTick: 450, noticeTicks: 450 })).toEqual({
      accepted: false,
      reason: 'pad-fault',
    });
    const closed = new FakeNest(nestConfig(), new Rng('closed'));
    closed.close();
    expect(closed.requestDock({ droneId: 1, arrivalTick: 450, noticeTicks: 450 })).toEqual({
      accepted: false,
      reason: 'nest-closed',
    });
  });

  it('gives dock-to-ready as a distribution, not a constant', () => {
    const nest = new FakeNest(
      nestConfig({ pads: 40, modules: 4, dockToReadySigma: 0.25, initialChargedPacks: 60 }),
      new Rng('latency')
    );
    const quoted: number[] = [];
    for (let id = 1; id <= 40; id++) {
      const decision = nest.requestDock({ droneId: id, arrivalTick: 450, noticeTicks: 450 });
      if (decision.accepted) quoted.push(decision.readyAtTick - 450);
    }
    expect(quoted.length).toBe(40);
    expect(new Set(quoted).size).toBeGreaterThan(20);
    const mean = quoted.reduce((a, b) => a + b, 0) / quoted.length;
    expect(mean).toBeGreaterThan(400);
    expect(mean).toBeLessThan(520);
    expect(Math.max(...quoted)).toBeGreaterThan(Math.min(...quoted) * 1.2);
  });

  it('reports pad state per slot and takes a pad back from a no-show', () => {
    const nest = new FakeNest(nestConfig(), new Rng('pads'));
    expect(padStates).toContain(nest.padState(0));
    expect(nest.padState(0)).toBe('free');
    nest.requestDock({ droneId: 1, arrivalTick: 450, noticeTicks: 450 });
    nest.advance(450);
    expect(nest.padState(0)).toBe('occupied');
    expect(nest.padAcceptsNow(0, 1)).toBe(true);
    expect(nest.padAcceptsNow(0, 2)).toBe(false);
    nest.advance(450 + 601);
    // Never turned up: the pad is not held for the rest of the show.
    expect(nest.padState(0)).toBe('free');
    expect(nest.record.noShows).toBe(1);
    nest.requestDock({ droneId: 9, arrivalTick: 2000, noticeTicks: 450 });
    nest.advance(2000);
    nest.confirmArrival(0, 9, 2000);
    expect(nest.padState(0)).toBe('swapping');
    const completed = nest.advance(2000 + 600);
    expect(completed.map((c) => c.droneId)).toContain(9);
  });

  it('does not let one aircraft release a pad another is swapping on', () => {
    const nest = new FakeNest(nestConfig(), new Rng('relinquish'));
    nest.requestDock({ droneId: 1, arrivalTick: 450, noticeTicks: 450 });
    nest.advance(450);
    nest.confirmArrival(0, 1, 450);
    expect(nest.padState(0)).toBe('swapping');
    nest.relinquish(0, 7);
    expect(nest.padState(0)).toBe('swapping');
    nest.relinquish(0, 1);
    expect(nest.padState(0)).toBe('free');
  });
});

describe('the nest is sized from the hub arithmetic, not from a number someone liked', () => {
  it.each([
    [
      50,
      {
        padsNeeded: 7,
        modules: 5,
        packSlotsPerModule: 65,
        packsInRotation: 325,
        airframesNeeded: 63,
      },
    ],
    [
      200,
      {
        padsNeeded: 25,
        modules: 20,
        packSlotsPerModule: 65,
        packsInRotation: 1300,
        airframesNeeded: 250,
      },
    ],
    [
      1000,
      {
        padsNeeded: 125,
        modules: 100,
        packSlotsPerModule: 65,
        packsInRotation: 6500,
        airframesNeeded: 1250,
      },
    ],
  ])('matches tools/show_sizing.py at %i airborne drones', (airborne, expected) => {
    const sized = sizeGroundSystem({ airborne });
    expect(sized.padsNeeded).toBe(expected.padsNeeded);
    expect(sized.modules).toBe(expected.modules);
    expect(sized.packSlotsPerModule).toBe(expected.packSlotsPerModule);
    expect(sized.packsInRotation).toBe(expected.packsInRotation);
    expect(sized.airframesNeeded).toBe(expected.airframesNeeded);
    expect(sized.chargeMinutes).toBe(30);
  });
  it('keeps the inputs the script documents', () => {
    expect(defaultSizingInputs).toMatchObject({
      airborne: 50,
      airMinutes: 6,
      chargeCRate: 2,
      dockMinutes: 0.75,
      moduleDrones: 10,
    });
  });
});

describe('contract 4: the Restricted Area is a free-fall calculation', () => {
  it('grows with altitude by both the waiver rule and the ballistic throw', () => {
    const low = restrictedAreaWidth({
      maxAltitude: 30,
      initialVelocity: 8,
      tailwind: 5,
      safetyFactor: 1.5,
    });
    const high = restrictedAreaWidth({
      maxAltitude: 120,
      initialVelocity: 8,
      tailwind: 5,
      safetyFactor: 1.5,
    });
    expect(high.waiverRuleMetres).toBeGreaterThan(low.waiverRuleMetres);
    expect(high.ballisticMetres).toBeGreaterThan(low.ballisticMetres);
    expect(high.metres).toBeGreaterThan(low.metres);
    // +10 m per 100 ft: 120 m is 393.7 ft, so 39.37 m.
    expect(high.waiverRuleMetres).toBeCloseTo(39.37, 1);
    // Free fall from 120 m is 4.95 s; 13 m/s of travel, with a 1.5 safety factor.
    expect(high.fallSeconds).toBeCloseTo(4.947, 2);
    expect(high.ballisticMetres).toBeCloseTo(1.5 * 13 * 4.947, 1);
    expect(high.binding).toBe('ballistic');
    expect(high.metres).toBe(high.ballisticMetres);
  });
  it('is zero on the ground and never negative', () => {
    const ground = restrictedAreaWidth({
      maxAltitude: 0,
      initialVelocity: 8,
      tailwind: 5,
      safetyFactor: 1.5,
    });
    expect(ground.metres).toBe(0);
    expect(
      restrictedAreaWidth({ maxAltitude: -5, initialVelocity: 8, tailwind: 5, safetyFactor: 1.5 })
        .metres
    ).toBe(0);
  });
});

describe('determinism is structural, not incidental', () => {
  it('gives named streams that do not move when a new consumer appears', () => {
    const a = new Rng('run-seed');
    const first = [a.fork('fleet').next(), a.fork('nest').next()];
    const b = new Rng('run-seed');
    b.fork('a-new-consumer').next();
    expect([b.fork('fleet').next(), b.fork('nest').next()]).toEqual(first);
  });
  it('produces the same sequence from the same seed and a different one otherwise', () => {
    const draw = (seed: string) => Array.from({ length: 8 }, () => new Rng(seed).next());
    expect(draw('x')).toEqual(draw('x'));
    expect(new Rng('x').next()).not.toBe(new Rng('y').next());
  });
  it('reads no wall clock and no unseeded randomness in the engine or the fakes', () => {
    // The harness is allowed one wall-clock read, for the elapsed time it returns
    // *beside* the report rather than inside it. Everything else is forbidden.
    const forbidden = /Date\.now|new Date|performance\.now|Math\.random|crypto\./;
    for (const file of [
      'engine.ts',
      'fake-fleet.ts',
      'fake-nest.ts',
      'show-plan.ts',
      'spacing.ts',
      'trace.ts',
      'report.ts',
      'geofence.ts',
      'rng.ts',
      'nest-sizing.ts',
      'contracts.ts',
    ]) {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
      expect(source, `${file} must not read a wall clock`).not.toMatch(forbidden);
    }
    const harness = readFileSync(fileURLToPath(new URL('./harness.ts', import.meta.url)), 'utf8');
    expect(harness.match(/Date\.now/g) ?? []).toHaveLength(2);
    expect(harness).not.toMatch(/Math\.random|performance\.now/);
  });
});
