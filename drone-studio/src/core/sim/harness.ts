/**
 * The full-show simulation harness.
 *
 * It owns the clock, the fakes, the injections and the measurement. The engine
 * sees contracts 1 and 2 and nothing else; the harness sees ground truth, which
 * is how it can catch a fleet that reports better accuracy than it delivers --
 * a failure the engine cannot see from telemetry alone.
 *
 * Nothing here reads a wall clock except `elapsedMs`, which is returned beside
 * the report rather than inside it, so the report stays byte-identical.
 */

import { Rng } from './rng';
import { sizeGroundSystem } from './nest-sizing';
import { buildShowPlan, PlanEvaluator, TICK_HZ, TICK_SECONDS, type ShowPlan } from './show-plan';
import { buildGeofence, type Geofence, type GeofenceInputs } from './geofence';
import { FakeFleet, type FakeFleetConfig } from './fake-fleet';
import { FakeNest, type FakeNestConfig } from './fake-nest';
import {
  defaultEngineConfig,
  ShowEngine,
  SIM_ENGINE_VERSION,
  type Composability,
  type EngineConfig,
  type EngineEvent,
} from './engine';
import { digest, mm, ms, Trace, TRACE_FORMAT } from './trace';
import { closestPair } from './spacing';
import { geofenceZones, type AbortMode, type Vec3 } from './contracts';
import type { ContainmentMargin } from './geofence';

export type InjectionKind =
  | 'fault'
  | 'silence'
  | 'command-refusal'
  | 'late-swap'
  | 'starve-magazine'
  | 'pad-fault'
  | 'accuracy-shortfall'
  | 'optimistic-accuracy'
  | 'mass-loss';

export type Injection = {
  tick: number;
  kind: InjectionKind;
  /** Omitted means "whichever drone makes this worst", resolved deterministically. */
  droneId?: number;
  magnitude?: number;
  count?: number;
  note?: string;
};

export type SimulationConfig = {
  seed: string;
  label: string;
  /** Formation slots: drones that must be on station. */
  airborne: number;
  showSeconds: number;
  /** Rotation demand as a fraction of the nest's capacity. 1.2 must refuse to compose. */
  targetUtilisation: number;
  declaredErrorVolume: number;
  deliveredErrorVolume: number;
  /** Fraction of a pack the engine may never command a drone below. */
  reserveFraction: number;
  maxSimultaneousLoss: number;
  /** Ticks between ground-truth safety samples. 1 at 50 drones; coarser above. */
  sampleEveryTicks: number;
  /** Ticks between trace rows. */
  traceEvery: number;
  /** Contingency landings this run tolerates, as a fraction of rotations. A
   *  dropout is correct behaviour -- an aircraft on its reserve lands rather than
   *  breaching it -- but a rate above this says the ground system is too small. */
  dropoutBudget: number;
  /** Airframes beyond the arithmetic minimum, as a multiplier. Handover waits are
   *  not in the rotation-period arithmetic, so the minimum is always short. */
  rosterSlack: number;
  /**
   * Mean formation-slot vacancy this run tolerates before the verdict degrades.
   *
   * A rotated show cannot be gapless: a slot's relief has to wait beside it while
   * the aircraft it replaces descends out of the column, which costs this ingress
   * design most of the relief's outbound leg. At 50 aircraft over an hour that
   * measures around 18%, so the budget is a little above it. It is a fidelity
   * figure, not a safety one, and the report prints the measurement next to it.
   */
  vacancyTolerance: number;
  injections: Injection[];
  /** Debug-only: builds internal collections backwards. Output must not move. */
  insertionOrder: 'natural' | 'reversed';
  engine: Partial<EngineConfig>;
  /** Override the derived pack endurance, for the at-capacity and beyond tests. */
  airSecondsOverride?: number;
  /** Override the derived roster size. */
  rosterOverride?: number;
  nest: Partial<FakeNestConfig>;
  geofence?: Partial<GeofenceInputs>;
};

export function defaultSimulationConfig(
  overrides: Partial<SimulationConfig> = {}
): SimulationConfig {
  const airborne = overrides.airborne ?? 50;
  return {
    seed: 'armable-g1-0001',
    label: `hour-long show, ${airborne} drones`,
    airborne,
    showSeconds: 3600,
    targetUtilisation: 0.7,
    declaredErrorVolume: 0.4,
    deliveredErrorVolume: 0.4,
    reserveFraction: 0.2,
    maxSimultaneousLoss: Math.max(1, Math.round(airborne * 0.06)),
    sampleEveryTicks: airborne <= 64 ? 1 : 5,
    traceEvery: airborne <= 64 ? 10 : 50,
    dropoutBudget: 0.1,
    rosterSlack: 1.2,
    vacancyTolerance: 0.2,
    injections: [],
    insertionOrder: 'natural',
    engine: {},
    nest: {},
    ...overrides,
  };
}

export type Sizing = {
  pads: number;
  modules: number;
  packSlotsPerModule: number;
  dockToReadyMedianTicks: number;
  requiredNoticeTicks: number;
  packTurnaroundTicks: number;
  capacityPerMinute: number;
  airSeconds: number;
  reserveSeconds: number;
  roster: number;
  padPositions: Vec3[];
  /** The figure the hub's script predicts, for comparison in the report. */
  scriptAirMinutes: number;
  scriptAirframes: number;
};

/**
 * Pads, modules and the magazine come from the hub's own arithmetic. Pack
 * endurance does not: it is *solved for*, so that rotation demand lands on the
 * requested fraction of the nest's capacity.
 *
 * That solve is where this harness disagrees with the hub. `show_sizing.py`
 * treats `air_minutes` as time on station, but a show engine honouring a
 * reserve, an outbound transit and one dock cycle of notice gets far less than
 * the pack's nameplate endurance on station. The report prints both figures.
 */
export function deriveSizing(
  config: SimulationConfig,
  engine: EngineConfig,
  plan: ShowPlan
): Sizing {
  const script = sizeGroundSystem({ airborne: config.airborne });
  const dockMinutes = 0.75;
  const dockToReadyMedianTicks = Math.round(dockMinutes * 60 * TICK_HZ);
  const corridorClearTicks = Math.round(4 * TICK_HZ);
  // The same occupancy the fake nest advertises: swap time plus corridor.
  const capacityPerMinute =
    script.padsNeeded / ((dockToReadyMedianTicks + corridorClearTicks) / (TICK_HZ * 60));
  const noticeTicks = dockToReadyMedianTicks;
  const noticeSeconds = noticeTicks * TICK_SECONDS;
  const outbound =
    engine.transitBaseAltitude / engine.verticalSpeed +
    (plan.maxRadius + 80) / engine.cruiseSpeed +
    (plan.maxAltitude - engine.transitBaseAltitude) / engine.verticalSpeed;
  const onStation = (config.airborne * 60) / (capacityPerMinute * config.targetUtilisation);
  const airSeconds =
    config.airSecondsOverride ??
    Math.ceil(
      (onStation + outbound + noticeSeconds + engine.returnMarginSeconds) /
        (1 - config.reserveFraction)
    );
  const reserveSeconds = Math.round(airSeconds * config.reserveFraction);
  const actualOnStation = Math.max(
    1,
    airSeconds - reserveSeconds - outbound - noticeSeconds - engine.returnMarginSeconds
  );
  const period = outbound + actualOnStation + noticeSeconds + dockToReadyMedianTicks * TICK_SECONDS;
  // The rotation period above is the arithmetic minimum: time on station, the
  // dock cycle of notice, the swap, and the flight back out. The real period is
  // longer, because a relief waits beside its slot for the aircraft it is
  // replacing to get out of the column. Sizing the roster to the minimum leaves
  // no airframe spare and the formation carries the shortfall as gaps, so it is
  // sized with slack -- which is a requirement this harness produces for the
  // airframe arm, over and above the hub script's figure.
  const roster =
    config.rosterOverride ??
    Math.ceil((config.airborne * period * config.rosterSlack) / actualOnStation) +
      config.maxSimultaneousLoss;
  return {
    pads: script.padsNeeded,
    modules: script.modules,
    packSlotsPerModule: script.packSlotsPerModule,
    dockToReadyMedianTicks,
    requiredNoticeTicks: noticeTicks,
    packTurnaroundTicks: Math.round((script.chargeMinutes + 3) * 60 * TICK_HZ),
    capacityPerMinute,
    airSeconds,
    reserveSeconds,
    roster,
    padPositions: padLayout(script.padsNeeded),
    scriptAirMinutes: 6,
    scriptAirframes: script.airframesNeeded,
  };
}

/**
 * Pads sit in rows behind the show, all at negative y, outside the choreography's
 * own radius. That placement is load-bearing: a transit leg leaves the pad row
 * and never returns to it, so a cruising drone cannot pass over another pad's
 * climb-out column -- and where rows do stack up at large fleet sizes, the
 * engine's crossing reservations catch the overlap and hold.
 */
export function padLayout(pads: number, spacing = 6, rowSpacing = 12, offset = 60): Vec3[] {
  const perRow = Math.min(pads, 20);
  return Array.from({ length: pads }, (_, i) => {
    const row = Math.floor(i / perRow);
    const column = i % perRow;
    const width = Math.min(perRow, pads - row * perRow);
    return [(column - (width - 1) / 2) * spacing, -(offset + row * rowSpacing), 0] as Vec3;
  });
}

/**
 * The launch grid: drone j starts directly beneath slot j, because the show's
 * opening cue is that grid. Spare airframes sit in rows behind the show, where
 * they are out of the way; they only become usable after a pad cycle, which the
 * report states rather than implying a deeper reserve than there is.
 */
export function launchGrid(plan: ShowPlan, roster: number): Vec3[] {
  const opening = new PlanEvaluator(plan).positions(0);
  return Array.from({ length: roster }, (_, i) => {
    if (i < plan.droneCount) return [opening[i * 3], opening[i * 3 + 1], 0] as Vec3;
    const spare = i - plan.droneCount;
    return [((spare % 10) - 4.5) * 8, 60 + Math.floor(spare / 10) * 8, 0] as Vec3;
  });
}

/** The choreography floor has to clear the band stack and both staging layers. */
function planFor(
  config: SimulationConfig,
  engine: EngineConfig,
  commandedSpacing: number
): ShowPlan {
  const transitCeiling =
    engine.transitBaseAltitude + (engine.transitBands * 2 - 1) * engine.transitLaneSpacing;
  const stageIn = transitCeiling + 2 * commandedSpacing;
  return buildShowPlan({
    droneCount: config.airborne,
    showSeconds: config.showSeconds,
    commandedSpacing,
    floor: Math.ceil(stageIn + commandedSpacing + 2),
    ceiling: config.geofence?.flightAreaCeiling ?? 200,
  });
}

/** Bands needed to carry this show's rotation demand, with 1.6x headroom. */
function bandsNeeded(
  config: SimulationConfig,
  engine: EngineConfig,
  plan: ShowPlan,
  sizing: Sizing
): number {
  const notice = sizing.requiredNoticeTicks * TICK_SECONDS;
  const outbound =
    engine.transitBaseAltitude / engine.verticalSpeed +
    (plan.maxRadius + 80) / engine.cruiseSpeed +
    (plan.maxAltitude - engine.transitBaseAltitude) / engine.verticalSpeed;
  const onStation = Math.max(
    1,
    sizing.airSeconds - sizing.reserveSeconds - outbound - notice - engine.returnMarginSeconds
  );
  const demand = plan.durationSeconds > onStation ? (config.airborne * 60) / onStation : 0;
  const transitCeiling =
    engine.transitBaseAltitude + (engine.transitBands * 2 - 1) * engine.transitLaneSpacing;
  const commandedSpacing = plan.composition.commandedSpacing;
  const cruise = (plan.maxRadius + 80) / engine.cruiseSpeed;
  const hold = Math.max(
    engine.transitBaseAltitude / engine.verticalSpeed + cruise,
    (transitCeiling + 2 * commandedSpacing - engine.transitBaseAltitude) / engine.verticalSpeed +
      cruise
  );
  // Twice the steady-state need. Rotation arrives in bursts -- a late pad, a held
  // column -- and a band that is not there when an aircraft wants to leave its
  // slot is paid for out of that aircraft's reserve.
  return Math.min(64, Math.max(8, Math.ceil((demand * hold * 2) / 60)));
}

export type FaultTimelineEntry = {
  tick: number;
  showSeconds: number;
  injection: string;
  droneId: number;
  note: string;
  /** What the engine did about it, in its own words, within 30 s. */
  response: string[];
};

export type Verdict =
  'pass' | 'degraded' | 'fail' | 'aborted' | 'contract-violation' | 'refused-to-compose';

export type RunReport = {
  format: string;
  engineVersion: string;
  verdict: Verdict;
  verdictReasons: string[];
  seed: string;
  label: string;
  inputs: {
    show: {
      name: string;
      droneCount: number;
      durationSeconds: number;
      bpm: number;
      leadInSeconds: number;
      cueSeconds: number;
      transitionSeconds: number;
      segments: number;
      cues: number;
      maxAltitude: number;
      minAltitude: number;
      maxRadius: number;
      peakCommandedSpeed: number;
      projectCapSeconds: number;
      composition: {
        commandedSpacing: number;
        usedShapes: string[];
        /** Shapes the builder would not sequence, and why. */
        rejectedShapes: string[];
        worstFormationSeparation: number;
        worstTransitionSeparation: number;
        rejectedAdjacencies: number;
        transitionSamples: number;
      };
    };
    fleet: {
      roster: number;
      declaredErrorVolume: number;
      deliveredErrorVolume: number;
      airSeconds: number;
      reserveSeconds: number;
      maxSimultaneousLoss: number;
    };
    nest: {
      pads: number;
      modules: number;
      packSlotsPerModule: number;
      rotationCapacityPerModulePerMinute: number;
      rotationCapacityPerMinute: number;
      medianDockToReadySeconds: number;
      dockToReadySigma: number;
      requiredNoticeSeconds: number;
      sizingSource: string;
    };
    geofence: {
      zone: string;
      radius: number;
      ceiling: number;
      behaviourOnViolation: string;
    }[];
    engine: EngineConfig;
    injections: Injection[];
    digests: { show: string; fleet: string; nest: string; geofence: string; engine: string };
  };
  composability: Composability;
  separation: {
    requiredSpacing: number;
    /** True separation the commanded gap guarantees while the fleet is honest. */
    truthFloor: number;
    spacingSource: string;
    minimumAchieved: number;
    /** Metres of room left against the floor the commanded gap guarantees. */
    margin: number;
    /** Metres against the commanded gap itself. Negative is expected: aircraft
     *  spend their declared error volume, which is what it is for. */
    marginAgainstCommanded: number;
    atTick: number;
    atShowSeconds: number;
    droneA: number;
    droneB: number;
    engineViewMinimum: number;
    collisionThreshold: number;
    breaches: number;
    /** Conflicts where at least one aircraft was no longer under command. */
    descentConflicts: number;
    samples: number;
    sampleEveryTicks: number;
    probeMetres: number;
    ticksWithNoPairInProbe: number;
  };
  reserve: {
    declaredReserveSeconds: number;
    lowestMarginSeconds: number;
    atTick: number;
    atShowSeconds: number;
    droneId: number;
    breaches: number;
    /** Samples where an aircraft the engine could not command was below reserve. */
    uncommandedBreaches: number;
  };
  containment: {
    margins: (ContainmentMargin & { behaviour: string; zoneRadius: number })[];
    restrictedArea: Geofence['restrictedArea'];
    breaches: number;
    impliedByAltitude: number;
  };
  dropouts: {
    count: number;
    budget: number;
    /** Contingency landings per completed rotation. Contract 4 reports this. */
    ratePerRotation: number;
    log: { tick: number; droneId: number; reason: string }[];
  };
  handover: {
    slots: number;
    peakVacantSlots: number;
    meanVacantSlots: number;
    reliefLaunches: number;
    reliefUnavailable: number;
    /** Mean fraction of formation slots occupied across the run. */
    slotFillRate: number;
  };
  losses: { declaredMax: number; peakConcurrent: number; total: number };
  rotation: {
    demandPerMinute: number;
    capacityPerMinute: number;
    utilisation: number;
    requested: number;
    accepted: number;
    refused: number;
    refusalsByReason: Record<string, number>;
    late: number;
    worstLatenessSeconds: number;
    padUtilisation: number;
    swapsCompleted: number;
    lowestChargedPacks: number;
    substitutions: number;
    transitHolds: number;
    /** Aircraft sent to a different pad on short final because theirs was taken. */
    diversions: number;
    diversionsRequested: number;
    /** Bookings whose aircraft never arrived, which the nest cancelled. */
    noShows: number;
  };
  faultTimeline: FaultTimelineEntry[];
  abort: {
    tick: number;
    showSeconds: number;
    mode: AbortMode;
    reason: string;
    correct: boolean;
  } | null;
  audio: {
    bpm: number;
    beatsPlayed: number;
    maxCueBoundaryBeatError: number;
    maxMotionAudioOffsetSeconds: number;
    locked: boolean;
  };
  contractViolations: { tick: number; droneId: number; observer: string; detail: string }[];
  determinism: {
    seed: string;
    traceFormat: string;
    traceDigest: string;
    traceRows: number;
    traceLines: number;
    reportDigest: string;
    insertionOrder: string;
    rngDraws: number;
    fixedTimestepHz: number;
  };
  scale: { ticks: number; droneStateUpdates: number };
  limitations: string[];
};

export type SimulationRun = {
  report: RunReport;
  trace: string;
  events: EngineEvent[];
  /** Wall clock, deliberately outside the report. */
  elapsedMs: number;
  /** Per-sample metrics, for the worst-moment search. */
  samples: {
    tick: number;
    minSeparation: number;
    reserveMargin: number;
    onStation: number;
    inTransit: number;
  }[];
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
};

export type Simulation = {
  config: SimulationConfig;
  engineConfig: EngineConfig;
  plan: ShowPlan;
  sizing: Sizing;
  fence: Geofence;
  geofenceInputs: GeofenceInputs;
  fleetConfig: FakeFleetConfig;
  nestConfig: FakeNestConfig;
  fleet: FakeFleet;
  nest: FakeNest;
  engine: ShowEngine;
  rng: Rng;
  commandedSpacing: number;
};

/**
 * Build every part of a run without stepping it, so a test can drive the clock
 * itself -- which the abort matrix needs, because an abort has to be issued at a
 * chosen moment rather than waiting for one to turn up.
 */
export function buildSimulation(input: Partial<SimulationConfig> = {}): Simulation {
  const config = defaultSimulationConfig(input);
  // Commanded spacing is knowable before the plan exists: it comes from the
  // choreography's minimum, both airframes' bodies and both declared error
  // volumes. The plan is then composed to clear it.
  const commandedSpacing =
    (config.engine.minimumSeparation ?? defaultEngineConfig.minimumSeparation) +
    2 * config.declaredErrorVolume +
    2 * (config.engine.bodyRadius ?? defaultEngineConfig.bodyRadius);
  // Transit bands, the choreography floor and the rotation demand depend on each
  // other: more demand needs more bands, more bands push the floor up, a higher
  // floor makes each transit longer. Three passes settle it, and the result is
  // recorded so a reader can see the exchange rate -- one band per band-hold's
  // worth of demand, and `transitLaneSpacing` metres of altitude per band.
  let engineConfig: EngineConfig = { ...defaultEngineConfig, ...config.engine };
  let plan = planFor(config, engineConfig, commandedSpacing);
  let sizing = deriveSizing(config, engineConfig, plan);
  if (config.engine.transitBands === undefined)
    for (let pass = 0; pass < 3; pass++) {
      const bands = bandsNeeded(config, engineConfig, plan, sizing);
      if (bands === engineConfig.transitBands) break;
      engineConfig = { ...engineConfig, transitBands: bands };
      plan = planFor(config, engineConfig, commandedSpacing);
      sizing = deriveSizing(config, engineConfig, plan);
    }
  const rng = new Rng(config.seed);
  const geofenceInputs: GeofenceInputs = {
    flightAreaRadius: 160,
    flightAreaCeiling: 200,
    softMargin: 20,
    hardMargin: 20,
    ceilingMargin: 20,
    restricted: { initialVelocity: plan.peakSpeed, tailwind: 5, safetyFactor: 1.5 },
    ...config.geofence,
  };
  const fence = buildGeofence(geofenceInputs, plan.maxAltitude);
  const nestConfig: FakeNestConfig = {
    pads: sizing.pads,
    modules: sizing.modules,
    packSlotsPerModule: sizing.packSlotsPerModule,
    dockToReadyMedianTicks: sizing.dockToReadyMedianTicks,
    dockToReadySigma: 0.18,
    requiredNoticeTicks: sizing.requiredNoticeTicks,
    packTurnaroundTicks: sizing.packTurnaroundTicks,
    // The whole magazine is charged before the show: that is what the night
    // before a show is for, and an hour at this rotation rate needs far more
    // packs than there are airframes. Starving it is an injection, not a default.
    initialChargedPacks: sizing.packSlotsPerModule * sizing.modules,
    padPositions: sizing.padPositions,
    corridorRadius: 3,
    corridorClearTicks: Math.round(4 * TICK_HZ),
    noShowTicks: Math.round(60 * TICK_HZ),
    ...config.nest,
  };
  const fleetConfig: FakeFleetConfig = {
    size: sizing.roster,
    declaredErrorVolume: config.declaredErrorVolume,
    deliveredErrorVolume: config.deliveredErrorVolume,
    airSeconds: sizing.airSeconds,
    reserveSeconds: sizing.reserveSeconds,
    maxSimultaneousLoss: config.maxSimultaneousLoss,
    homePositions: launchGrid(plan, sizing.roster),
    descentSpeed: 2.5,
    errorRefreshTicks: 10,
  };
  const fleet = new FakeFleet(fleetConfig, rng.fork('fleet'), config.insertionOrder);
  const nest = new FakeNest(nestConfig, rng.fork('nest'), config.insertionOrder);
  const engine = new ShowEngine(plan, fleet, nest, fence, engineConfig);

  return {
    config,
    engineConfig,
    plan,
    sizing,
    fence,
    geofenceInputs,
    fleetConfig,
    nestConfig,
    fleet,
    nest,
    engine,
    rng,
    commandedSpacing,
  };
}

export function runShowSimulation(input: Partial<SimulationConfig> = {}): SimulationRun {
  const started = Date.now();
  const built = buildSimulation(input);
  const {
    config,
    engineConfig,
    plan,
    sizing,
    fence,
    geofenceInputs,
    fleetConfig,
    nestConfig,
    fleet,
    nest,
    engine,
    rng,
  } = built;
  const composability = engine.composability();
  const totalTicks = Math.round(config.showSeconds * TICK_HZ);
  const trace = new Trace(config.traceEvery);
  trace.comment(`${TRACE_FORMAT} engine=${SIM_ENGINE_VERSION} seed=${config.seed}`);
  trace.comment(
    `fields: tick onStation airborne inTransit vacant lost minSepMm reserveMarginMs engineSepMm`
  );
  // The collection insertion order is deliberately *not* a trace field: it is a
  // debug knob, and building the roster backwards must produce a byte-identical
  // trace. It is recorded in the report's determinism block instead.
  trace.row('config', [
    config.airborne,
    config.showSeconds,
    sizing.roster,
    sizing.pads,
    mm(engine.requiredSeparation),
    ms(sizing.airSeconds),
    ms(sizing.reserveSeconds),
  ]);

  const samples: SimulationRun['samples'] = [];
  const injectionLog: FaultTimelineEntry[] = [];
  let minSeparation = Infinity,
    minSeparationTick = -1,
    minSeparationA = 0,
    minSeparationB = 0;
  let lowestReserve = Infinity,
    lowestReserveTick = -1,
    lowestReserveDrone = 0;
  let separationBreaches = 0,
    descentConflicts = 0,
    reserveBreaches = 0,
    uncommandedReserveBreaches = 0,
    geofenceBreaches = 0,
    sampleCount = 0,
    probeMisses = 0,
    peakConcurrentLoss = 0,
    engineViewMinimum = Infinity;
  const harnessViolations: RunReport['contractViolations'] = [];
  const probe = Math.max(8, engine.requiredSeparation * 3);
  const pending = [...config.injections].sort(
    (a, b) => a.tick - b.tick || a.kind.localeCompare(b.kind)
  );
  let nextInjection = 0;

  if (composability.composable) {
    for (let tick = 0; tick < totalTicks; tick++) {
      while (nextInjection < pending.length && pending[nextInjection].tick === tick) {
        const injection = pending[nextInjection++];
        injectionLog.push(applyInjection(injection, tick, engine, fleet, nest));
      }
      const snapshot = engine.step(tick);
      engine.releaseClearedPads();
      fleet.advance(tick + 1);
      for (const done of nest.advance(tick + 1)) engine.swapComplete(done.droneId, done.pad);

      peakConcurrentLoss = Math.max(peakConcurrentLoss, snapshot.lost);
      engineViewMinimum = Math.min(engineViewMinimum, snapshot.engineMinSeparation || Infinity);
      if ((tick + 1) % config.sampleEveryTicks === 0 || tick + 1 === totalTicks) {
        sampleCount++;
        // Ground truth, which the engine never sees. Airborne drones only: a drone
        // on a pad is not a traffic conflict.
        const ids: number[] = [];
        const points: number[] = [];
        for (let id = 1; id <= fleet.size; id++) {
          if (!fleet.isAirborne(id)) continue;
          const p = fleet.truePosition(id);
          ids.push(id);
          points.push(p[0], p[1], p[2]);
          const breached = engine.containment.observe(p, id, tick + 1);
          if (breached.length) {
            geofenceBreaches++;
            engine.noteBreach(
              'geofence-breach',
              id,
              `Left ${breached.join(' and ')} at ${p.map((v) => v.toFixed(1)).join(', ')}.`
            );
          }
          const truth = fleet.truth(id);
          const margin = truth.energy - fleet.reserveSeconds;
          if (margin < lowestReserve) {
            lowestReserve = margin;
            lowestReserveTick = tick + 1;
            lowestReserveDrone = id;
          }
          if (margin < 0) {
            // Contract 1's promise is that the engine will never *command* an
            // aircraft below its declared reserve. An aircraft that has stopped
            // taking commands is outside that promise: it will fly until its pack
            // is flat, and the engine has no way to stop it. Counted and
            // explained, not scored as the engine breaking its word.
            if (engine.underCommand(id)) {
              reserveBreaches++;
              engine.noteBreach(
                'reserve-breach',
                id,
                `Commanded aircraft airborne with ${truth.energy.toFixed(1)} s against a ` +
                  `${fleet.reserveSeconds} s declared reserve.`
              );
            } else {
              uncommandedReserveBreaches++;
              if (engine.counters.reserveBreaches < 8)
                engine.noteBreach(
                  'reserve-breach',
                  id,
                  `Aircraft ${id} (${engine.phaseOf(id)}) is below its reserve with ` +
                    `${truth.energy.toFixed(1)} s left, and is not under command. A drone that stopped ` +
                    `reporting flies until its pack is flat; nothing the engine does changes that.`
                );
            }
          }
          // The declared error volume is the number the engine spaces from. If the
          // fleet delivers worse than it declares, the guarantee is void -- and a
          // drone that also reports optimistically can only be caught here.
          const nominal = fleet.nominalPosition(id);
          const delivered = Math.hypot(p[0] - nominal[0], p[1] - nominal[1], p[2] - nominal[2]);
          if (delivered > fleet.declaredErrorVolume * 1.2 && harnessViolations.length < 8) {
            const detail =
              `CONTRACT 1 VIOLATION, observed by the harness from ground truth: drone ${id} is ` +
              `${delivered.toFixed(2)} m from its nominal path while the fleet declares ` +
              `${fleet.declaredErrorVolume.toFixed(2)} m. Its own telemetry claims ` +
              `${fleet.declaredErrorVolume.toFixed(2)} m accuracy, so the engine cannot see this. ` +
              `Every separation figure in this report is computed against the declaration and is void.`;
            harnessViolations.push({ tick: tick + 1, droneId: id, observer: 'harness', detail });
            engine.noteHarnessContractViolation(id, detail);
          }
        }
        const closest = ids.length < 2 ? null : closestPair(points, probe, ids);
        if (!closest) probeMisses++;
        else {
          if (closest.distance < minSeparation) {
            minSeparation = closest.distance;
            minSeparationTick = tick + 1;
            minSeparationA = closest.a;
            minSeparationB = closest.b;
          }
          if (closest.distance < engine.truthSeparationFloor) {
            // A conflict with an aircraft the engine no longer commands -- faulted,
            // gone quiet, or coming down on its reserve -- is a different claim
            // from a conflict between two aircraft it was flying, and is counted
            // separately rather than scored as a spacing failure.
            const commanded = engine.underCommand(closest.a) && engine.underCommand(closest.b);
            if (commanded) separationBreaches++;
            else descentConflicts++;
            if (engine.counters.separationBreaches + engine.counters.descentConflicts < 48)
              engine.noteBreach(
                commanded ? 'separation-breach' : 'descent-conflict',
                closest.a,
                `Drones ${closest.a} (${engine.phaseOf(closest.a)}) and ${closest.b} ` +
                  `(${engine.phaseOf(closest.b)}) were ${closest.distance.toFixed(2)} m apart in ground ` +
                  `truth, inside the ${engine.truthSeparationFloor.toFixed(2)} m floor that the ` +
                  `${engine.requiredSeparation.toFixed(2)} m commanded gap is meant to guarantee.` +
                  (commanded
                    ? ''
                    : ' One of them was not under command, so this is a forced-descent conflict rather' +
                      ' than a spacing failure -- see the limitations.')
              );
          }
        }
        samples.push({
          tick: tick + 1,
          minSeparation: closest ? closest.distance : Infinity,
          reserveMargin: Number.isFinite(lowestReserve) ? lowestReserve : 0,
          onStation: snapshot.onStation,
          inTransit: snapshot.inTransit,
        });
        if ((tick + 1) % config.traceEvery === 0)
          trace.row('t', [
            tick + 1,
            snapshot.onStation,
            snapshot.airborne,
            snapshot.inTransit,
            snapshot.vacantSlots,
            snapshot.lost,
            closest ? mm(closest.distance) : -1,
            ms(Number.isFinite(lowestReserve) ? lowestReserve : 0),
            mm(snapshot.engineMinSeparation),
          ]);
      }
      if (engine.aborted) break;
    }
  }

  for (const event of engine.events)
    trace.row('e', [event.tick, event.kind, event.droneId, event.detail.replace(/\s+/g, ' ')]);

  const audio = measureAudioLock(plan, totalTicks);
  const containmentMargins = engine.containmentMargins().map((m) => ({
    ...m,
    behaviour: zoneBehaviour(m.zone),
    zoneRadius: fence.zones[m.zone].radius,
  }));
  const padUtilisation = nest.record.padTicks ? nest.record.padBusyTicks / nest.record.padTicks : 0;
  const contractViolations = [
    ...engine.contractViolations.map((v) => ({
      tick: v.tick,
      droneId: v.droneId,
      observer: 'engine',
      detail: v.detail,
    })),
    ...harnessViolations,
  ].sort((a, b) => a.tick - b.tick || a.droneId - b.droneId);

  const slotFillRate = engine.vacancy.ticks
    ? 1 - engine.vacancy.totalSlotTicks / (engine.vacancy.ticks * plan.droneCount)
    : 0;
  // A budget proportional to rotations alone is degenerate for a show that does
  // not rotate, so it is also proportional to the fleet: a show with no rotations
  // still has a mass launch to get wrong.
  const dropoutBudget = Math.max(
    2,
    Math.ceil(Math.max(nest.record.docksAccepted * config.dropoutBudget, config.airborne * 0.03))
  );
  const verdictReasons: string[] = [];
  let verdict: Verdict = 'pass';
  if (!composability.composable) {
    verdict = 'refused-to-compose';
    verdictReasons.push(...composability.reasons);
  } else if (contractViolations.length) {
    verdict = 'contract-violation';
    verdictReasons.push(
      `${contractViolations.length} contract 1 violation(s). The fleet did not deliver what it declared, ` +
        `so the engine's separation guarantee never applied. This is not a software defect and must not be filed as one.`
    );
  } else if (separationBreaches > 0 || reserveBreaches > 0 || geofenceBreaches > 0) {
    verdict = 'fail';
    if (separationBreaches)
      verdictReasons.push(
        `${separationBreaches} separation breach(es) between aircraft the engine was commanding.`
      );
    if (reserveBreaches) verdictReasons.push(`${reserveBreaches} reserve breach(es).`);
    if (geofenceBreaches) verdictReasons.push(`${geofenceBreaches} geofence breach(es).`);
  } else if (engine.aborted) {
    verdict = 'aborted';
    verdictReasons.push(engine.aborted.reason);
  } else if (
    engine.counters.dropouts > dropoutBudget ||
    descentConflicts > 0 ||
    uncommandedReserveBreaches > 0 ||
    slotFillRate < 1 - config.vacancyTolerance
  ) {
    verdict = 'degraded';
    if (uncommandedReserveBreaches > 0)
      verdictReasons.push(
        `${uncommandedReserveBreaches} sample(s) where an aircraft not under command was below its ` +
          `reserve. An aircraft that stops reporting flies until its pack is flat.`
      );
    if (descentConflicts > 0)
      verdictReasons.push(
        `${descentConflicts} forced-descent conflict(s): an aircraft that was faulted, silent or ` +
          `landing on its reserve came within the separation floor of another. The engine does not ` +
          `clear a path for an aircraft it cannot command, and this is the metric that says so.`
      );
    if (engine.counters.dropouts > dropoutBudget)
      verdictReasons.push(
        `${engine.counters.dropouts} dropout(s) against a budget of ${dropoutBudget} ` +
          `(${(config.dropoutBudget * 100).toFixed(0)}% of ${nest.record.docksAccepted} rotations). ` +
          `Each one is an aircraft that reached its reserve while holding and landed rather than ` +
          `breaching it, which is the correct call -- but a show that makes it often is a show with ` +
          `too little ground throughput.`
      );
    if (slotFillRate < 1 - config.vacancyTolerance)
      verdictReasons.push(
        `Formation slots were ${(slotFillRate * 100).toFixed(1)}% occupied on average, below the ` +
          `${((1 - config.vacancyTolerance) * 100).toFixed(0)}% this run allows for handover. A rotated show ` +
          `always carries some handover vacancy; this is more than that.`
      );
  } else
    verdictReasons.push(
      `No separation, reserve or containment breach, no contract violation, and no aircraft lost. ` +
        `Formation slots were ${(slotFillRate * 100).toFixed(1)}% occupied on average across ` +
        `${engine.vacancy.ticks} ticks, the rest being slot handover.`
    );

  const inputs: RunReport['inputs'] = {
    show: {
      name: plan.name,
      droneCount: plan.droneCount,
      durationSeconds: plan.durationSeconds,
      bpm: plan.bpm,
      leadInSeconds: plan.leadInSeconds,
      cueSeconds: plan.cueSeconds,
      transitionSeconds: plan.transitionSeconds,
      segments: plan.segments.length,
      cues: plan.segments.reduce((n, s) => n + s.cues.length, 0),
      maxAltitude: round(plan.maxAltitude, 2),
      minAltitude: round(plan.minAltitude, 2),
      maxRadius: round(plan.maxRadius, 2),
      peakCommandedSpeed: round(plan.peakSpeed, 2),
      projectCapSeconds: 1800,
      composition: {
        commandedSpacing: round(plan.composition.commandedSpacing, 3),
        usedShapes: plan.composition.usedShapes,
        rejectedShapes: plan.composition.shapes
          .filter((c) => c.rejected)
          .map((c) => `${c.shape}: ${c.rejected}`),
        worstFormationSeparation: round(plan.composition.worstFormationSeparation, 3),
        worstTransitionSeparation: round(plan.composition.worstTransitionSeparation, 3),
        rejectedAdjacencies: plan.composition.rejectedAdjacencies,
        transitionSamples: plan.composition.transitionSamples,
      },
    },
    fleet: {
      roster: fleetConfig.size,
      declaredErrorVolume: fleetConfig.declaredErrorVolume,
      deliveredErrorVolume: fleetConfig.deliveredErrorVolume,
      airSeconds: fleetConfig.airSeconds,
      reserveSeconds: fleetConfig.reserveSeconds,
      maxSimultaneousLoss: fleetConfig.maxSimultaneousLoss,
    },
    nest: {
      pads: nestConfig.pads,
      modules: nestConfig.modules,
      packSlotsPerModule: nestConfig.packSlotsPerModule,
      rotationCapacityPerModulePerMinute: round(nest.rotationCapacityPerModulePerMinute, 3),
      rotationCapacityPerMinute: round(nest.rotationCapacityPerMinute, 3),
      medianDockToReadySeconds: nestConfig.dockToReadyMedianTicks * TICK_SECONDS,
      dockToReadySigma: nestConfig.dockToReadySigma,
      requiredNoticeSeconds: nestConfig.requiredNoticeTicks * TICK_SECONDS,
      sizingSource:
        `tools/show_sizing.py --airborne ${config.airborne}: ${sizing.pads} pads, ${sizing.modules} modules, ` +
        `${sizing.packSlotsPerModule}-slot magazine per module, ${sizing.scriptAirframes} airframes at a ` +
        `${sizing.scriptAirMinutes}-minute pack`,
    },
    geofence: geofenceZones.map((zone) => ({
      zone,
      radius: round(fence.zones[zone].radius, 2),
      ceiling: round(fence.zones[zone].ceiling, 2),
      behaviourOnViolation: zoneBehaviour(zone),
    })),
    engine: engineConfig,
    injections: config.injections,
    digests: {
      show: digest(stableJson(plan.segments)),
      fleet: digest(stableJson(fleetConfig)),
      nest: digest(stableJson(nestConfig)),
      geofence: digest(stableJson(geofenceInputs)),
      engine: digest(stableJson(engineConfig)),
    },
  };

  const report: RunReport = {
    format: 'armable-show-sim-report/1',
    engineVersion: SIM_ENGINE_VERSION,
    verdict,
    verdictReasons,
    seed: config.seed,
    label: config.label,
    inputs,
    composability,
    separation: {
      requiredSpacing: round(engine.requiredSeparation, 3),
      truthFloor: round(engine.truthSeparationFloor, 3),
      spacingSource:
        `choreography minimum ${engineConfig.minimumSeparation} m + 2 x body radius ` +
        `${engineConfig.bodyRadius} m + 2 x declared error volume ${fleetConfig.declaredErrorVolume} m. ` +
        `If the fleet delivers its declaration, true centre-to-centre separation cannot fall below ` +
        `${round(engine.truthSeparationFloor, 2)} m.`,
      minimumAchieved: Number.isFinite(minSeparation) ? round(minSeparation, 3) : -1,
      margin: Number.isFinite(minSeparation)
        ? round(minSeparation - engine.truthSeparationFloor, 3)
        : -1,
      marginAgainstCommanded: Number.isFinite(minSeparation)
        ? round(minSeparation - engine.requiredSeparation, 3)
        : -1,
      atTick: minSeparationTick,
      atShowSeconds: round(minSeparationTick * TICK_SECONDS, 1),
      droneA: minSeparationA,
      droneB: minSeparationB,
      engineViewMinimum: Number.isFinite(engineViewMinimum) ? round(engineViewMinimum, 3) : -1,
      collisionThreshold: round(engineConfig.bodyRadius * 2, 3),
      breaches: Math.max(0, separationBreaches),
      descentConflicts,
      samples: sampleCount,
      sampleEveryTicks: config.sampleEveryTicks,
      probeMetres: round(probe, 2),
      ticksWithNoPairInProbe: probeMisses,
    },
    reserve: {
      declaredReserveSeconds: fleetConfig.reserveSeconds,
      lowestMarginSeconds: Number.isFinite(lowestReserve) ? round(lowestReserve, 2) : -1,
      atTick: lowestReserveTick,
      atShowSeconds: round(lowestReserveTick * TICK_SECONDS, 1),
      droneId: lowestReserveDrone,
      breaches: reserveBreaches,
      uncommandedBreaches: uncommandedReserveBreaches,
    },
    containment: {
      margins: containmentMargins.map((m) => ({
        ...m,
        horizontal: round(m.horizontal, 2),
        vertical: round(m.vertical, 2),
      })),
      restrictedArea: {
        ...fence.restrictedArea,
        waiverRuleMetres: round(fence.restrictedArea.waiverRuleMetres, 2),
        ballisticMetres: round(fence.restrictedArea.ballisticMetres, 2),
        metres: round(fence.restrictedArea.metres, 2),
        fallSeconds: round(fence.restrictedArea.fallSeconds, 2),
      },
      breaches: geofenceBreaches,
      impliedByAltitude: round(plan.maxAltitude, 2),
    },
    dropouts: {
      count: engine.counters.dropouts,
      budget: dropoutBudget,
      ratePerRotation: round(
        nest.record.docksAccepted ? engine.counters.dropouts / nest.record.docksAccepted : 0,
        4
      ),
      log: engine.dropoutLog.slice(0, 64),
    },
    handover: {
      slots: plan.droneCount,
      peakVacantSlots: engine.vacancy.peak,
      meanVacantSlots: round(
        engine.vacancy.ticks ? engine.vacancy.totalSlotTicks / engine.vacancy.ticks : 0,
        3
      ),
      reliefLaunches: engine.counters.reliefLaunches,
      reliefUnavailable: engine.counters.reliefUnavailable,
      slotFillRate: round(
        engine.vacancy.ticks
          ? 1 - engine.vacancy.totalSlotTicks / (engine.vacancy.ticks * plan.droneCount)
          : 0,
        4
      ),
    },
    losses: {
      declaredMax: fleetConfig.maxSimultaneousLoss,
      peakConcurrent: peakConcurrentLoss,
      total: engine.assignments.filter((a) => a.lost).length,
    },
    rotation: {
      demandPerMinute: round(composability.rotationDemandPerMinute, 3),
      capacityPerMinute: round(composability.rotationCapacityPerMinute, 3),
      utilisation: round(composability.utilisation, 4),
      requested: nest.record.docksRequested,
      accepted: nest.record.docksAccepted,
      refused: nest.record.docksRefused,
      refusalsByReason: { ...nest.record.refusalsByReason },
      late: nest.record.docksLate,
      worstLatenessSeconds: round(nest.record.worstLatenessTicks * TICK_SECONDS, 1),
      padUtilisation: round(padUtilisation, 4),
      swapsCompleted: nest.record.swapsCompleted,
      lowestChargedPacks: Number.isFinite(nest.record.chargedPackLow)
        ? nest.record.chargedPackLow
        : -1,
      substitutions: engine.counters.substitutions,
      transitHolds: engine.counters.transitHolds,
      diversions: engine.counters.diversions,
      diversionsRequested: nest.record.diversionsRequested,
      noShows: nest.record.noShows,
    },
    faultTimeline: injectionLog.map((entry) => ({
      ...entry,
      response: engine.events
        .filter((e) => e.tick >= entry.tick && e.tick <= entry.tick + 30 * TICK_HZ)
        .slice(0, 12)
        .map((e) => `+${round((e.tick - entry.tick) * TICK_SECONDS, 1)}s ${e.kind}: ${e.detail}`),
    })),
    abort: engine.aborted
      ? {
          tick: engine.aborted.tick,
          showSeconds: round(engine.aborted.tick * TICK_SECONDS, 1),
          mode: engine.aborted.mode,
          reason: engine.aborted.reason,
          correct:
            peakConcurrentLoss > fleetConfig.maxSimultaneousLoss || contractViolations.length > 0,
        }
      : null,
    audio,
    contractViolations,
    determinism: {
      seed: config.seed,
      traceFormat: TRACE_FORMAT,
      traceDigest: trace.digest(),
      traceRows: trace.rowCount,
      traceLines: trace.lineCount,
      reportDigest: '',
      insertionOrder: config.insertionOrder,
      rngDraws: rng.count,
      fixedTimestepHz: TICK_HZ,
    },
    scale: {
      ticks: totalTicks,
      droneStateUpdates: totalTicks * fleetConfig.size,
    },
    limitations: [
      "No flight dynamics, aerodynamics, radio or battery chemistry. Out of scope by design: this harness tests the engine's decisions, not physics.",
      `Ground-truth safety is sampled every ${config.sampleEveryTicks} tick(s) (${round(config.sampleEveryTicks * TICK_SECONDS, 2)} s). Conflicts between samples are not observed.`,
      `Closest-pair search probes to ${round(probe, 1)} m. ${probeMisses} sample(s) found no pair inside that radius and contribute no minimum.`,
      'Position error is a drift model inside a sphere, not a GNSS model. It is the right shape for spacing decisions and nothing more.',
      'A forced descent is not routed. When an aircraft faults, goes quiet or lands on its reserve, the engine reserves the column it is coming down and holds other traffic out of it, but it does not move aircraft that are already on station below it, and a crossing already committed is not re-checked. Conflicts of that kind are counted as forced-descent conflicts, not as spacing failures, and closing that gap needs the engine to re-route commanded aircraft around an uncommanded descent.',
      'An unfilled formation slot is flown as a gap. The engine does not redistribute drones to close gaps, so the choreography degrades visually before it degrades in safety.',
      'Geofence zones are cylinders about the show origin. Real waiver boundaries are polygons.',
      'Contract 4 figures are provisional: the hub records them as waiver excerpts awaiting primary confirmation.',
      'The restricted-area free-fall calculation ignores drag, so it is conservative for a light airframe and should not be read as a drop test.',
    ],
  };
  report.determinism.reportDigest = digest(
    stableJson({ ...report, determinism: { ...report.determinism, reportDigest: '' } })
  );
  return {
    report,
    trace: trace.text(),
    events: engine.events,
    elapsedMs: Date.now() - started,
    samples,
  };
}

function round(value: number, places: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function zoneBehaviour(zone: string): string {
  if (zone === 'soft-fence') return 'return to home or autoland';
  if (zone === 'hard-fence') return 'motors stop';
  if (zone === 'restricted-area')
    return 'ground footprint kept clear of non-participating people; containment is ballistic once motors stop';
  return 'composition error: the choreography was authored outside its own envelope';
}

/**
 * Music and motion, across the whole hour rather than a clip.
 *
 * Two things can come apart. Cue boundaries can fall off the beat grid, which is
 * a composition fault; and the show time the engine evaluates motion at can
 * drift from the audio clock, which is an engine fault. Both are measured.
 */
function measureAudioLock(plan: ShowPlan, totalTicks: number): RunReport['audio'] {
  const evaluator = new PlanEvaluator(plan);
  const beat = 60 / plan.bpm;
  let maxBoundaryError = 0;
  let elapsed = 0;
  for (const segment of plan.segments)
    for (const cue of segment.cues) {
      const beats = elapsed / beat;
      maxBoundaryError = Math.max(maxBoundaryError, Math.abs(beats - Math.round(beats)));
      elapsed += cue.duration;
    }
  let maxOffset = 0;
  for (let tick = 0; tick <= totalTicks; tick++) {
    const audioTime = tick * TICK_SECONDS;
    const located = evaluator.locate(audioTime);
    const motionTime = plan.segmentStarts[located.segment] + located.localTime;
    maxOffset = Math.max(maxOffset, Math.abs(motionTime - audioTime));
  }
  return {
    bpm: plan.bpm,
    beatsPlayed: Math.floor((totalTicks * TICK_SECONDS) / beat),
    maxCueBoundaryBeatError: round(maxBoundaryError, 12),
    maxMotionAudioOffsetSeconds: round(maxOffset, 12),
    locked: maxBoundaryError < 1e-9 && maxOffset < 1e-9,
  };
}

/**
 * Apply one injection, resolving "whichever drone makes this worst" into a
 * specific id by a deterministic rule rather than a random pick.
 */
function applyInjection(
  injection: Injection,
  tick: number,
  engine: ShowEngine,
  fleet: FakeFleet,
  nest: FakeNest
): FaultTimelineEntry {
  const onStation = engine.assignments
    .filter((a) => a.phase === 'on-station' && !a.lost)
    .sort((a, b) => a.id - b.id);
  const returning = engine.assignments
    .filter(
      (a) => a.phase === 'cruise-in' || a.phase === 'descend-to-pad' || a.phase === 'swapping'
    )
    .sort((a, b) => a.id - b.id);
  // Worst case for a loss is the drone with the tightest neighbours, because its
  // slot is the hardest to vacate and refill without crowding.
  const tightest = () => {
    let best = onStation[0],
      bestDistance = Infinity;
    for (const a of onStation) {
      let nearest = Infinity;
      for (const other of onStation) {
        if (other.id === a.id) continue;
        const d = Math.hypot(
          a.commanded[0] - other.commanded[0],
          a.commanded[1] - other.commanded[1],
          a.commanded[2] - other.commanded[2]
        );
        if (d < nearest) nearest = d;
      }
      if (nearest < bestDistance) {
        bestDistance = nearest;
        best = a;
      }
    }
    return best;
  };
  const note = injection.note ?? '';
  const describe = (id: number, text: string): FaultTimelineEntry => ({
    tick,
    showSeconds: round(tick * TICK_SECONDS, 1),
    injection: injection.kind,
    droneId: id,
    note: note ? `${text} ${note}` : text,
    response: [],
  });
  switch (injection.kind) {
    case 'fault': {
      const target = injection.droneId ?? tightest()?.id ?? 1;
      fleet.injectFault(target);
      return describe(target, `Drone ${target} entered fault mid-formation.`);
    }
    case 'silence': {
      const target = injection.droneId ?? tightest()?.id ?? 1;
      fleet.injectSilence(target);
      return describe(
        target,
        `Drone ${target} stopped reporting while on station. It is still flying its last ` +
          `waypoint, so an engine that treats it as stationary is wrong twice.`
      );
    }
    case 'command-refusal': {
      const target = injection.droneId ?? tightest()?.id ?? 1;
      fleet.injectCommandRefusal(target, injection.magnitude ?? 600);
      return describe(
        target,
        `Drone ${target} refuses commands for ${round((injection.magnitude ?? 600) * TICK_SECONDS, 1)} s.`
      );
    }
    case 'late-swap': {
      const target = injection.droneId ?? returning[0]?.id ?? onStation[0]?.id ?? 1;
      nest.injectLateSwap(target, injection.magnitude ?? 600);
      return describe(
        target,
        `Drone ${target}'s next swap runs ${round((injection.magnitude ?? 600) * TICK_SECONDS, 1)} s late.`
      );
    }
    case 'starve-magazine': {
      nest.setChargedPacks(injection.count ?? 0);
      return describe(
        0,
        `Magazine starved to ${injection.count ?? 0} charged packs; the nest must refuse.`
      );
    }
    case 'pad-fault': {
      const pad = injection.count ?? 0;
      nest.injectPadFault(pad);
      return describe(0, `Pad ${pad} faulted.`);
    }
    case 'accuracy-shortfall': {
      const target = injection.droneId ?? tightest()?.id ?? 1;
      fleet.injectAccuracyShortfall(target, injection.magnitude ?? 0.4, false);
      return describe(
        target,
        `Drone ${target} now delivers ${injection.magnitude ?? 0.4} m against a declared ` +
          `${fleet.declaredErrorVolume} m, and reports its true position.`
      );
    }
    case 'optimistic-accuracy': {
      const target = injection.droneId ?? tightest()?.id ?? 1;
      fleet.injectAccuracyShortfall(target, injection.magnitude ?? 0.4, true);
      return describe(
        target,
        `Drone ${target} now delivers ${injection.magnitude ?? 0.4} m against a declared ` +
          `${fleet.declaredErrorVolume} m, and reports a position inside the declaration. Only ` +
          `ground truth can catch this.`
      );
    }
    case 'mass-loss': {
      const count = injection.count ?? fleet.maxSimultaneousLoss + 1;
      const targets = onStation.slice(0, count).map((a) => a.id);
      for (const id of targets) fleet.injectSilence(id);
      return describe(
        targets[0] ?? 0,
        `${targets.length} drones (${targets.join(', ')}) stopped reporting at once, above the ` +
          `declared max_simultaneous_loss of ${fleet.maxSimultaneousLoss}.`
      );
    }
  }
}

export type WorstMoments = {
  /** The tick at which the fleet was closest together. */
  tightestSeparation: number;
  /** The tick at which some aircraft had least energy above its reserve. */
  lowestReserve: number;
  /** The tick with the most aircraft in transit at once. */
  busiestTransit: number;
  /** A tick inside a cue transition, when the whole formation is moving. */
  midTransition: number;
  /** A tick with a pack swap in progress. */
  midSwap: number;
};

/**
 * The worst moment for each kind of injection, taken from a baseline run rather
 * than picked at random.
 *
 * The spec is specific about this: an injection at a random moment proves very
 * little, because the moment that matters is the one where the engine has least
 * room. So the harness runs the show once clean, reads off where it was tightest
 * and where it was poorest, and injects there.
 */
export function worstMoments(run: SimulationRun): WorstMoments {
  let tightest = run.samples[0]?.tick ?? 0,
    tightestValue = Infinity;
  let poorest = run.samples[0]?.tick ?? 0,
    poorestValue = Infinity;
  let busiest = run.samples[0]?.tick ?? 0,
    busiestValue = -1;
  for (const sample of run.samples) {
    if (Number.isFinite(sample.minSeparation) && sample.minSeparation < tightestValue) {
      tightestValue = sample.minSeparation;
      tightest = sample.tick;
    }
    if (sample.onStation > 0 && sample.reserveMargin < poorestValue) {
      poorestValue = sample.reserveMargin;
      poorest = sample.tick;
    }
    if (sample.inTransit > busiestValue) {
      busiestValue = sample.inTransit;
      busiest = sample.tick;
    }
  }
  const show = run.report.inputs.show;
  const midTransition = Math.round(
    (show.leadInSeconds + show.cueSeconds + show.transitionSeconds / 2) * TICK_HZ
  );
  const firstSwap = run.events.find((e) => e.kind === 'swap-complete');
  const midSwap = firstSwap
    ? Math.max(
        1,
        firstSwap.tick - Math.round(run.report.inputs.nest.medianDockToReadySeconds * TICK_HZ) / 2
      )
    : busiest;
  return {
    tightestSeparation: tightest,
    lowestReserve: poorest,
    busiestTransit: busiest,
    midTransition,
    midSwap: Math.round(midSwap),
  };
}
