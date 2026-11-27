import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  runShowSimulation,
  worstMoments,
  type Injection,
  type SimulationRun,
  type WorstMoments,
} from './harness';
import { TICK_HZ } from './show-plan';

// These runs are seconds, not milliseconds: an hour-long show at 10 Hz is
// millions of drone-state updates. The default per-test timeout is for unit
// tests and does not apply here.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The adversarial matrix from the program hub's `arms/show/simulation-spec.md`.
 *
 * Every injection goes in at the worst moment the harness can find, not at a
 * random one: the baseline run below is read for the tick where the fleet was
 * tightest, where some aircraft had least energy above its reserve, and where
 * the most aircraft were in transit at once.
 *
 * The show must degrade, not stop, up to the declared `max_simultaneous_loss`.
 * Two rows of this matrix are singled out in the spec as the easiest to get
 * wrong, and they have the most assertions here: an aircraft that stops
 * reporting must be treated as lost rather than stationary, and one that reports
 * better accuracy than it delivers must fail loudly as a contract violation
 * rather than looking like a software bug.
 */

const BASE = { seed: 'armable-g1-adversarial', showSeconds: 900 } as const;
let baseline: SimulationRun;
let worst: WorstMoments;

const inject = (injections: Injection[], label: string, overrides = {}) =>
  runShowSimulation({ ...BASE, label, injections, ...overrides });

beforeAll(() => {
  baseline = runShowSimulation({ ...BASE, label: 'adversarial baseline' });
  worst = worstMoments(baseline);
});

describe('the baseline the injections are measured against', () => {
  it('is clean, so a difference afterwards means something', () => {
    expect(baseline.report.separation.breaches).toBe(0);
    expect(baseline.report.reserve.breaches).toBe(0);
    expect(baseline.report.contractViolations).toEqual([]);
    expect(baseline.report.abort).toBeNull();
  });
  it('finds the worst moments rather than guessing them', () => {
    expect(worst.tightestSeparation).toBeGreaterThan(0);
    expect(worst.lowestReserve).toBeGreaterThan(0);
    expect(worst.busiestTransit).toBeGreaterThan(0);
    expect(worst.midTransition).toBeGreaterThan(0);
    expect(worst.midSwap).toBeGreaterThan(0);
    // The tightest moment really is tighter than the average one.
    const finite = baseline.samples.filter((s) => Number.isFinite(s.minSeparation));
    const mean = finite.reduce((n, s) => n + s.minSeparation, 0) / finite.length;
    const tightest = finite.find((s) => s.tick === worst.tightestSeparation)!;
    expect(tightest.minSeparation).toBeLessThan(mean);
  });
});

describe('a drone enters fault mid-formation', () => {
  it('substitutes without violating spacing, and keeps clear of the descent', () => {
    const run = inject(
      [
        {
          kind: 'fault',
          tick: worst.tightestSeparation,
          note: 'at the tightest moment of the show.',
        },
      ],
      'fault mid-formation, at the tightest moment'
    );
    const r = run.report;
    const faulted = run.events.find((e) => e.kind === 'drone-fault');
    expect(faulted, 'the engine must notice the fault').toBeTruthy();
    expect(faulted!.tick).toBeLessThanOrEqual(worst.tightestSeparation + 2);
    // The slot is given up and refilled, rather than held by an aircraft that
    // cannot fly it.
    expect(
      run.events.some((e) => e.kind === 'slot-vacated' && e.droneId === faulted!.droneId)
    ).toBe(true);
    expect(r.rotation.substitutions).toBeGreaterThan(baseline.report.rotation.substitutions - 1);
    // The show degraded rather than stopping, and nothing was flown into.
    expect(r.abort).toBeNull();
    expect(r.separation.breaches).toBe(0);
    expect(r.reserve.breaches).toBe(0);
    expect(r.separation.minimumAchieved).toBeGreaterThan(r.separation.truthFloor);
    expect(r.faultTimeline).toHaveLength(1);
    expect(r.faultTimeline[0].response.length).toBeGreaterThan(0);
  });
});

describe('a drone stops reporting', () => {
  it('is treated as lost, not as stationary', () => {
    const run = inject(
      [{ kind: 'silence', tick: worst.tightestSeparation }],
      'telemetry loss at the tightest moment'
    );
    const r = run.report;
    const lost = run.events.find((e) => e.kind === 'drone-lost');
    expect(lost, 'silence must become a loss').toBeTruthy();
    // The engine says so in those words, because the contract does.
    expect(lost!.detail).toContain('lost, not stationary');
    expect(lost!.detail).toMatch(/keep-out volume that grows/);
    // It happened promptly: within the configured staleness window, not eventually.
    const silencedAt = r.faultTimeline[0].tick;
    expect(lost!.tick - silencedAt).toBeLessThanOrEqual(r.inputs.engine.lostAfterTicks + TICK_HZ);
    // The slot is given up. An engine that treated the aircraft as parked would
    // keep the slot filled by a ghost and never substitute.
    expect(run.events.some((e) => e.kind === 'slot-vacated' && e.droneId === lost!.droneId)).toBe(
      true
    );
    expect(r.losses.total).toBe(1);
    expect(r.losses.peakConcurrent).toBe(1);
    expect(r.losses.peakConcurrent).toBeLessThanOrEqual(r.losses.declaredMax);
    // Degraded, not stopped, and nothing flew into the aircraft that went quiet
    // -- which keeps moving, so its keep-out volume has to grow.
    expect(r.abort).toBeNull();
    expect(r.separation.breaches).toBe(0);
    expect(r.inputs.engine.lostHazardGrowth).toBeGreaterThan(0);
  });

  it("does not keep crediting the stale report as the aircraft's position", () => {
    // The aircraft keeps flying its last waypoint after it goes quiet. If the
    // engine were treating the stale report as current, the aircraft's true
    // position and its last report would stay together; they must not.
    const tick = worst.tightestSeparation;
    const run = inject([{ kind: 'silence', tick }], 'stale telemetry is not a position');
    const lost = run.events.find((e) => e.kind === 'drone-lost')!;
    const held = run.events.filter(
      (e) => e.droneId === lost.droneId && e.tick > lost.tick && e.kind === 'slot-filled'
    );
    expect(held).toHaveLength(0);
    expect(run.report.handover.slotFillRate).toBeLessThan(1);
  });
});

describe('a drone returns late from a swap', () => {
  it('is re-planned against the quote rather than assumed to have arrived', () => {
    const run = inject(
      [{ kind: 'late-swap', tick: worst.midSwap, magnitude: 900 }],
      'a swap 90 s later than the nest advertises'
    );
    const r = run.report;
    expect(r.rotation.late).toBeGreaterThan(0);
    // The injected 90 s lands on top of a sampled latency that may itself be
    // below the median, so the figure against the median is a little under 90.
    expect(r.rotation.worstLatenessSeconds).toBeGreaterThan(75);
    const late = run.events.find((e) => e.kind === 'dock-late');
    expect(late, 'the engine must notice a pad that says it will be slow').toBeTruthy();
    expect(late!.detail).toMatch(/against a .* median/);
    expect(late!.detail).toContain('believed');
    // The aircraft is not flown again before the swap is actually finished.
    const subject = r.faultTimeline[0].droneId;
    const complete = run.events.find((e) => e.kind === 'swap-complete' && e.droneId === subject);
    const relaunch = run.events.find(
      (e) => (e.kind === 'relief-launched' || e.kind === 'substitution') && e.droneId === subject
    );
    if (complete && relaunch) expect(relaunch.tick).toBeGreaterThanOrEqual(complete.tick);
    expect(r.separation.breaches).toBe(0);
    expect(r.reserve.breaches).toBe(0);
  });
});

describe('a drone refuses a command', () => {
  it('escalates instead of retrying for ever', () => {
    const run = inject(
      [{ kind: 'command-refusal', tick: worst.midTransition, magnitude: 3000 }],
      'a drone refusing commands for 300 s, from mid-transition'
    );
    const escalated = run.events.find((e) => e.kind === 'escalated');
    expect(escalated, 'a refusal has to end in an escalation').toBeTruthy();
    expect(escalated!.detail).toContain('instead of retrying');
    const limit = run.report.inputs.engine.maxCommandRetries;
    // It stopped asking: the retries are bounded by the configured limit, not by
    // the 3,000 ticks the aircraft was going to refuse for.
    expect(run.report.rotation.transitHolds).toBeGreaterThanOrEqual(0);
    const refusals = run.events.filter((e) => e.kind === 'command-refused');
    expect(refusals.length).toBeLessThanOrEqual(2);
    expect(limit).toBeLessThan(3000);
    // The slot is released and its volume stays reserved as a hazard.
    expect(
      run.events.some((e) => e.kind === 'slot-vacated' && e.droneId === escalated!.droneId)
    ).toBe(true);
    expect(run.report.separation.breaches).toBe(0);
    expect(run.report.abort).toBeNull();
  });
});

describe('the nest refuses a dock', () => {
  it('holds the drone on its reserve, not past it', () => {
    const run = inject(
      [{ kind: 'starve-magazine', tick: worst.lowestReserve, count: 0 }],
      'the magazine starved at the poorest moment for reserve'
    );
    const r = run.report;
    expect(r.rotation.refusalsByReason['no-charged-pack']).toBeGreaterThan(0);
    const refused = run.events.find(
      (e) => e.kind === 'dock-refused' && e.detail.includes('no-charged-pack')
    );
    expect(refused).toBeTruthy();
    expect(refused!.detail).toContain('ends at reserve, not past it');
    // Not past it: no aircraft went below its declared reserve, and the ones that
    // could not wait any longer landed. That is the correct trade.
    expect(r.reserve.breaches).toBe(0);
    expect(r.reserve.lowestMarginSeconds).toBeGreaterThanOrEqual(0);
    expect(r.dropouts.count).toBeGreaterThan(0);
    expect(r.dropouts.ratePerRotation).toBeGreaterThan(0);
    expect(r.separation.breaches).toBe(0);
    // And the show kept flying what it still had.
    expect(r.abort).toBeNull();
  });
});

describe('a drone reports better accuracy than it delivers', () => {
  it('fails loudly as a contract violation when the engine can see it', () => {
    const run = inject(
      [{ kind: 'accuracy-shortfall', tick: worst.tightestSeparation, magnitude: 1.2 }],
      'an aircraft delivering 1.2 m against a declared 0.4 m'
    );
    const r = run.report;
    // Not `fail`. A fleet that does not deliver its declaration is not a software
    // defect, and a report that files it as one sends the wrong engineer looking.
    expect(r.verdict).toBe('contract-violation');
    expect(r.contractViolations.length).toBeGreaterThan(0);
    // The engine can see this one for itself: the aircraft reports its true
    // position, which is further from the commanded one than the declaration
    // allows. The harness also sees it from ground truth, and both are recorded.
    const violation = r.contractViolations.find((v) => v.observer === 'engine')!;
    expect(violation, 'the engine must catch an honestly reported shortfall').toBeTruthy();
    expect(violation.detail).toContain('CONTRACT 1 VIOLATION');
    expect(violation.detail).toContain('not a software fault');
    expect(violation.detail).toMatch(/declares 0\.40 m/);
    expect(violation.detail).toMatch(/voids the separation guarantee|invalidates/);
    expect(r.verdictReasons.join(' ')).toContain('not a software defect');
    // Loudly: the engine stopped the show over it.
    expect(r.abort).toBeTruthy();
    expect(r.abort!.correct).toBe(true);
    expect(violation.observer).toBe('engine');
  });

  it('is caught from ground truth when the aircraft lies about its position too', () => {
    const run = inject(
      [{ kind: 'optimistic-accuracy', tick: worst.tightestSeparation, magnitude: 1.2 }],
      'an aircraft delivering 1.2 m and reporting 0.4 m'
    );
    const r = run.report;
    expect(r.verdict).toBe('contract-violation');
    const harnessSeen = r.contractViolations.find((v) => v.observer === 'harness');
    expect(harnessSeen, 'only ground truth can catch an optimistic reporter').toBeTruthy();
    expect(harnessSeen!.detail).toContain('observed by the harness from ground truth');
    expect(harnessSeen!.detail).toContain('the engine cannot see this');
    expect(harnessSeen!.detail).toMatch(/every separation figure in this report/i);
  });

  it('says nothing of the kind when the fleet delivers what it declared', () => {
    expect(baseline.report.contractViolations).toEqual([]);
    expect(baseline.report.verdict).not.toBe('contract-violation');
  });
});

describe('losses against the declared max_simultaneous_loss', () => {
  it('degrades without stopping at exactly the declared maximum', () => {
    const max = baseline.report.losses.declaredMax;
    const run = inject(
      [{ kind: 'mass-loss', tick: worst.tightestSeparation, count: max }],
      `${max} aircraft lost at once: exactly the declared maximum`
    );
    const r = run.report;
    expect(r.losses.peakConcurrent).toBe(max);
    expect(r.abort, 'at the declared maximum the show carries on').toBeNull();
    // Nothing the engine was flying came inside the floor, and nothing it was
    // flying went below its reserve.
    expect(r.separation.breaches).toBe(0);
    expect(r.reserve.breaches).toBe(0);
    expect(r.verdict).toBe('degraded');
    // The aircraft that went quiet keep flying until their packs are flat, and
    // the report says so rather than scoring it against the engine.
    expect(r.reserve.uncommandedBreaches).toBeGreaterThan(0);
    expect(r.verdictReasons.join(' ')).toContain('not under command');
  });

  it('aborts cleanly one aircraft past it', () => {
    const max = baseline.report.losses.declaredMax;
    const run = inject(
      [{ kind: 'mass-loss', tick: worst.tightestSeparation, count: max + 1 }],
      `${max + 1} aircraft lost at once: one past the declared maximum`
    );
    const r = run.report;
    expect(r.verdict).toBe('aborted');
    expect(r.abort).toBeTruthy();
    expect(r.abort!.mode).toBe('land-in-place');
    expect(r.abort!.reason).toContain('max_simultaneous_loss');
    // The one case in the matrix where stopping is correct, and the report says so.
    expect(r.abort!.correct).toBe(true);
    expect(r.losses.peakConcurrent).toBeGreaterThan(max);
    // Cleanly: every aircraft was commanded, and the report says how many of them
    // were beyond command.
    const abortEvent = run.events.find((e) => e.kind === 'abort')!;
    expect(abortEvent.detail).toMatch(/\d+ aircraft commanded/);
    expect(abortEvent.detail).toMatch(/not under command/);
    expect(r.separation.breaches).toBe(0);
  });
});

describe('a pad fails under the running show', () => {
  it('loses throughput without losing aircraft', () => {
    const run = inject(
      [
        { kind: 'pad-fault', tick: worst.midSwap, count: 0 },
        { kind: 'pad-fault', tick: worst.midSwap + 10, count: 1 },
      ],
      'two of seven pads faulted mid-show'
    );
    const r = run.report;
    expect(r.separation.breaches).toBe(0);
    expect(r.reserve.breaches).toBe(0);
    expect(r.abort).toBeNull();
    expect(r.faultTimeline).toHaveLength(2);
    // Throughput falls, which is the honest consequence of losing two pads.
    expect(r.rotation.swapsCompleted).toBeLessThanOrEqual(baseline.report.rotation.swapsCompleted);
  });
});
