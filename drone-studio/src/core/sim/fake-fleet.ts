/**
 * The fake fleet: contract 1, implemented against nothing.
 *
 * It exists so the show engine can be tested before an aircraft does. It models
 * what the contract makes the fleet responsible for -- a declared error volume,
 * the six-state enum, energy in usable airborne seconds, timestamped trajectory
 * and light ingestion, abort, and faults -- and nothing else. There is no
 * aerodynamics here and there should never be any: the harness tests the
 * engine's decisions.
 *
 * The one feature that matters most is the ability to **under-deliver against
 * its own declaration**. A fleet that claims 10 cm and delivers 40 is the
 * failure contract 1 warns about, so the fake can be told to do exactly that,
 * either reporting its true (bad) position or reporting an optimistic one.
 */

import { Rng } from './rng';
import { TICK_SECONDS } from './show-plan';
import {
  droneStates,
  type AbortMode,
  type AbortOutcome,
  type DroneState,
  type DroneTelemetry,
  type FleetContract,
  type LightKeyframe,
  type TrajectoryKeyframe,
  type Vec3,
} from './contracts';

/** Why the engine is commanding a drone. Contract 1 reports `returning` as a
 *  state distinct from `flying` but gives the engine no way to say which it
 *  means, so the fake takes the intent alongside the trajectory. */
export type TrajectoryIntent = 'launch' | 'station' | 'return' | 'contingency-land';

export type FakeFleetConfig = {
  /** Roster size: every airframe, airborne or not. */
  size: number;
  /** What the fleet claims its position error volume is, metres. */
  declaredErrorVolume: number;
  /** What it actually delivers. Greater than declared is a contract violation. */
  deliveredErrorVolume: number;
  /** Fresh-pack endurance, usable airborne seconds. */
  airSeconds: number;
  /** Declared reserve, airborne seconds. */
  reserveSeconds: number;
  maxSimultaneousLoss: number;
  /** Where each roster drone starts and sits when it is on the ground: a launch
   *  grid position, not a swap pad. Shows launch from a grid; the nest's pads are
   *  for rotation. Indexed by drone id - 1. */
  homePositions: readonly Vec3[];
  /** Vertical speed the aircraft manages in a land-in-place or a fault descent. */
  descentSpeed: number;
  /** How often the position error is redrawn, ticks. Errors drift; they do not flicker. */
  errorRefreshTicks: number;
};

type Drone = {
  id: number;
  state: DroneState;
  /** Ground truth, which only the harness may read. */
  x: number;
  y: number;
  z: number;
  /** Current waypoint: be at this position by this tick. */
  wx: number;
  wy: number;
  wz: number;
  waypointTick: number;
  intent: TrajectoryIntent;
  energy: number;
  pad: number;
  /** Error offset interpolation, redrawn every `errorRefreshTicks`. The offset
   *  drifts rather than flickering, so a velocity estimate off telemetry is not
   *  nonsense -- but it is still an error model, not aerodynamics. */
  errorFrom: [number, number, number];
  errorTo: [number, number, number];
  errorPhase: number;
  /** The offset in force this tick: ground truth minus the nominal path. */
  ex: number;
  ey: number;
  ez: number;
  /** Per-drone overrides, set by injections. */
  deliveredError: number;
  optimisticReports: boolean;
  silentFromTick: number;
  refuseUntilTick: number;
  lastReport: DroneTelemetry | null;
  rng: Rng;
  trajectoryKeys: number;
  lightKeys: number;
  aborted: AbortMode | null;
};

export class FakeFleet implements FleetContract {
  private readonly drones: Drone[] = [];
  private tickNow = 0;
  /** Counters a run report can quote. */
  readonly counters = {
    trajectoryCommands: 0,
    trajectoryRefusals: 0,
    lightCommands: 0,
    faultsInjected: 0,
    silencesInjected: 0,
  };
  constructor(
    readonly config: FakeFleetConfig,
    rng: Rng,
    /** Debug-only: building the roster backwards must not change any output. */
    insertionOrder: 'natural' | 'reversed' = 'natural'
  ) {
    const order = Array.from({ length: config.size }, (_, i) => i + 1);
    if (insertionOrder === 'reversed') order.reverse();
    const made: Drone[] = [];
    for (const id of order) {
      const at = config.homePositions[id - 1] ?? ([0, 0, 0] as Vec3);
      // Streams are named by drone, so the roster's build order cannot shift them.
      const droneRng = rng.fork(`drone-${id}`);
      made.push({
        id,
        state: 'ready',
        x: at[0],
        y: at[1],
        z: 0,
        wx: at[0],
        wy: at[1],
        wz: 0,
        waypointTick: 0,
        intent: 'station',
        energy: config.airSeconds,
        pad: -1,
        errorFrom: [0, 0, 0],
        errorTo: droneRng.insideSphere(config.deliveredErrorVolume),
        errorPhase: 0,
        ex: 0,
        ey: 0,
        ez: 0,
        deliveredError: config.deliveredErrorVolume,
        optimisticReports: false,
        silentFromTick: -1,
        refuseUntilTick: -1,
        lastReport: null,
        rng: droneRng,
        trajectoryKeys: 0,
        lightKeys: 0,
        aborted: null,
      });
    }
    // Store by id regardless of build order: no output may depend on insertion.
    this.drones = made.slice().sort((a, b) => a.id - b.id);
    for (const drone of this.drones) this.report(drone, 0);
  }

  get size(): number {
    return this.config.size;
  }
  get declaredErrorVolume(): number {
    return this.config.declaredErrorVolume;
  }
  get reserveSeconds(): number {
    return this.config.reserveSeconds;
  }
  get maxSimultaneousLoss(): number {
    return this.config.maxSimultaneousLoss;
  }
  get airSeconds(): number {
    return this.config.airSeconds;
  }

  private drone(id: number): Drone {
    const drone = this.drones[id - 1];
    if (!drone || drone.id !== id) throw new Error(`No drone ${id} in the roster.`);
    return drone;
  }

  // --- contract 1 ---------------------------------------------------------

  telemetry(id: number): DroneTelemetry | null {
    return this.drone(id).lastReport;
  }

  ingestTrajectory(
    id: number,
    keys: readonly TrajectoryKeyframe[],
    intent: TrajectoryIntent = 'station'
  ): boolean {
    const drone = this.drone(id);
    this.counters.trajectoryCommands++;
    if (drone.refuseUntilTick >= this.tickNow) {
      this.counters.trajectoryRefusals++;
      return false;
    }
    if (drone.aborted) return false;
    if (!keys.length) return true;
    // Values are copied out here: the engine may reuse its keyframe buffers.
    const last = keys[keys.length - 1];
    drone.wx = last.position[0];
    drone.wy = last.position[1];
    drone.wz = last.position[2];
    drone.waypointTick = Math.max(this.tickNow + 1, Math.round(last.time / TICK_SECONDS));
    drone.intent = intent;
    drone.trajectoryKeys += keys.length;
    if (drone.state === 'ready' && intent === 'launch') drone.state = 'flying';
    else if (drone.state === 'flying' && intent === 'return') drone.state = 'returning';
    else if (drone.state === 'returning' && intent === 'station') drone.state = 'flying';
    return true;
  }

  ingestLights(id: number, keys: readonly LightKeyframe[]): boolean {
    const drone = this.drone(id);
    this.counters.lightCommands++;
    if (drone.refuseUntilTick >= this.tickNow) return false;
    drone.lightKeys += keys.length;
    return true;
  }

  abort(mode: AbortMode): AbortOutcome[] {
    const outcomes: AbortOutcome[] = [];
    for (const drone of this.drones) {
      const before = drone.state;
      drone.aborted = mode;
      if (before === 'fault' && drone.z > 0.5) {
        outcomes.push({
          id: drone.id,
          mode,
          stateBefore: before,
          disposition: 'uncommanded-descent',
          note: 'A faulted aircraft is not under command. It is coming down either way; the abort is recorded, not obeyed.',
        });
        continue;
      }
      if (drone.z <= 0.5) {
        outcomes.push({
          id: drone.id,
          mode,
          stateBefore: before,
          disposition: 'already-on-ground',
          note: `On the ground in state ${before}; nothing to stop.`,
        });
        continue;
      }
      if (mode === 'land-in-place') {
        drone.wx = drone.x;
        drone.wy = drone.y;
        drone.wz = 0;
        outcomes.push({
          id: drone.id,
          mode,
          stateBefore: before,
          disposition: 'landing',
          note: `Descending in place from ${drone.z.toFixed(1)} m at ${this.config.descentSpeed} m/s.`,
        });
      } else {
        drone.wx = drone.x;
        drone.wy = drone.y;
        drone.wz = drone.z;
        outcomes.push({
          id: drone.id,
          mode,
          stateBefore: before,
          disposition: 'holding',
          note: `Holding at ${drone.z.toFixed(1)} m until energy reserve forces a landing.`,
        });
      }
    }
    return outcomes;
  }

  // --- fault injection ----------------------------------------------------

  /** The drone enters `fault`. Airborne, it descends under its own failsafe. */
  injectFault(id: number) {
    const drone = this.drone(id);
    drone.state = 'fault';
    drone.wx = drone.x;
    drone.wy = drone.y;
    drone.wz = 0;
    this.counters.faultsInjected++;
  }
  /** The drone stops reporting. It keeps flying its last waypoint: the engine must
   *  not conclude it is parked where it was last seen. */
  injectSilence(id: number) {
    this.drone(id).silentFromTick = this.tickNow;
    this.counters.silencesInjected++;
  }
  /** The drone refuses commands for a while. The engine must escalate, not retry forever. */
  injectCommandRefusal(id: number, ticks: number) {
    this.drone(id).refuseUntilTick = this.tickNow + ticks;
  }
  /** The drone delivers worse accuracy than the fleet declares. With
   *  `optimisticReports` it also lies about where it is, so only an outside
   *  observer can catch it -- which is the harness's job, not the engine's. */
  injectAccuracyShortfall(id: number, deliveredMetres: number, optimisticReports = false) {
    const drone = this.drone(id);
    drone.deliveredError = deliveredMetres;
    drone.optimisticReports = optimisticReports;
    drone.errorTo = drone.rng.insideSphere(deliveredMetres);
    drone.errorPhase = this.config.errorRefreshTicks;
  }
  /** Ground truth, for the harness only. The engine may never call this. */
  truth(id: number): { position: Vec3; state: DroneState; energy: number; pad: number } {
    const drone = this.drone(id);
    return {
      position: this.truePosition(id),
      state: drone.state,
      energy: drone.energy,
      pad: drone.pad,
    };
  }
  /** Nest-side fact: a swapped pack restores endurance. Not part of contract 1. */
  restorePack(id: number) {
    const drone = this.drone(id);
    drone.energy = this.config.airSeconds;
    if (drone.state === 'charging' || drone.state === 'docked') drone.state = 'ready';
  }
  /** Nest-side fact: the drone is on the pad and the swap has begun. */
  markDocked(id: number, pad: number) {
    const drone = this.drone(id);
    drone.pad = pad;
    drone.state = 'charging';
  }
  isAirborne(id: number): boolean {
    return this.drone(id).z > 0.5;
  }
  states(): Record<DroneState, number> {
    const counts = Object.fromEntries(droneStates.map((s) => [s, 0])) as Record<DroneState, number>;
    for (const drone of this.drones) counts[drone.state]++;
    return counts;
  }

  // --- simulation ---------------------------------------------------------

  /** Advance every drone one fixed tick. No wall clock is read here or anywhere. */
  advance(tick: number) {
    this.tickNow = tick;
    for (const drone of this.drones) {
      this.move(drone);
      this.stepError(drone);
      if (drone.z > 0.5 && (drone.state === 'flying' || drone.state === 'returning'))
        drone.energy = Math.max(0, drone.energy - TICK_SECONDS);
      else if (drone.z > 0.5 && drone.state === 'fault')
        drone.energy = Math.max(0, drone.energy - TICK_SECONDS);
      // A drone is only on the ground when it was *told* to come down and got
      // there. Flipping state on altitude alone would park every drone one tick
      // into its own launch.
      if (
        drone.z <= 0.05 &&
        (drone.state === 'flying' || drone.state === 'returning') &&
        (drone.intent === 'return' || drone.intent === 'contingency-land')
      )
        drone.state = 'docked';
      this.report(drone, tick);
    }
  }

  private move(drone: Drone) {
    const descending = drone.state === 'fault' || drone.aborted === 'land-in-place';
    if (descending) {
      drone.z = Math.max(0, drone.z - this.config.descentSpeed * TICK_SECONDS);
      return;
    }
    if (drone.aborted === 'hold-position') return;
    const remaining = Math.max(1, drone.waypointTick - this.tickNow + 1);
    const step = 1 / remaining;
    drone.x += (drone.wx - drone.x) * step;
    drone.y += (drone.wy - drone.y) * step;
    drone.z += (drone.wz - drone.z) * step;
    if (Math.abs(drone.z) < 1e-6) drone.z = 0;
  }

  /** Advance this drone's position-error offset by one tick. */
  private stepError(drone: Drone) {
    if (drone.errorPhase <= 0) {
      drone.errorFrom = drone.errorTo;
      drone.errorTo = drone.rng.insideSphere(drone.deliveredError);
      drone.errorPhase = this.config.errorRefreshTicks;
    }
    const f = 1 - drone.errorPhase / this.config.errorRefreshTicks;
    drone.errorPhase--;
    drone.ex = drone.errorFrom[0] + (drone.errorTo[0] - drone.errorFrom[0]) * f;
    drone.ey = drone.errorFrom[1] + (drone.errorTo[1] - drone.errorFrom[1]) * f;
    drone.ez = drone.errorFrom[2] + (drone.errorTo[2] - drone.errorFrom[2]) * f;
  }

  private report(drone: Drone, tick: number) {
    // Silence means silence: the last report keeps its old tick, and the engine
    // has to notice. This is the single easiest bug in the program to write.
    if (drone.silentFromTick >= 0 && tick > drone.silentFromTick) return;
    const airborne = drone.z > 0.5;
    // An optimistic reporter shrinks its own error back inside the declaration,
    // so only an outside observer with ground truth can catch it.
    const scale =
      airborne && drone.optimisticReports && drone.deliveredError > 0
        ? Math.min(1, (this.config.declaredErrorVolume * 0.6) / drone.deliveredError)
        : 1;
    const reported: Vec3 = airborne
      ? [drone.x + drone.ex * scale, drone.y + drone.ey * scale, drone.z + drone.ez * scale]
      : [drone.x, drone.y, drone.z];
    drone.lastReport = {
      id: drone.id,
      state: drone.state,
      position: reported,
      reportedAccuracy: this.config.declaredErrorVolume,
      energyRemaining: drone.energy,
      tick,
    };
  }

  /** Ground-truth position including the delivered error. Harness only. */
  truePosition(id: number): Vec3 {
    const drone = this.drone(id);
    if (drone.z <= 0.5) return [drone.x, drone.y, drone.z];
    return [drone.x + drone.ex, drone.y + drone.ey, drone.z + drone.ez];
  }
  /** The nominal path position, without the error offset. Harness only. */
  nominalPosition(id: number): Vec3 {
    const drone = this.drone(id);
    return [drone.x, drone.y, drone.z];
  }
  deliveredErrorVolume(id: number): number {
    return this.drone(id).deliveredError;
  }
}
