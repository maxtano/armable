/**
 * The show engine's decision layer: slot assignment, rotation scheduling, loss
 * handling, geofence awareness and abort.
 *
 * `validation.ts` already tells a choreographer whether a *drawing* is safe. It
 * says so itself: "Takeoff, landing, drone assignment, downwash, positioning
 * uncertainty, and contingency routes need an operator planner." This is that
 * planner, and the thing the harness tests. It reads the fleet only through
 * contract 1 and the nest only through contract 2, and it has no access to
 * ground truth -- which is the whole point, because the harness does.
 *
 * The central decision is the **slot handover**. An hour-long show outlives any
 * pack, so a slot's holder has to be relieved: the engine launches the relief
 * early, parks it under the slot at its own transit altitude, releases the
 * holder, and only then lifts the relief in. A rotated show therefore has a few
 * slots in handover at any moment, which is a fidelity cost and not a safety
 * one -- the report measures it rather than hiding it.
 *
 * Determinism: no wall-clock reads, no RNG, and no iteration over a Map or Set
 * for anything that affects output. Everything walks arrays in id or index order.
 */

import { geofenceZones, type AbortMode, type DroneTelemetry, type Vec3 } from './contracts';
import { ContainmentTracker, type Geofence } from './geofence';
import { FakeFleet, type TrajectoryIntent } from './fake-fleet';
import { FakeNest } from './fake-nest';
import { PlanEvaluator, TICK_HZ, TICK_SECONDS, type ShowPlan } from './show-plan';

export const SIM_ENGINE_VERSION = '1.0.0';

export type EngineConfig = {
  /** The choreography's own floor. The engine's spacing is the larger of this and
   *  twice the declared error volume plus two airframe radii. */
  minimumSeparation: number;
  bodyRadius: number;
  /** Ticks without a report before a drone is declared lost rather than stationary. */
  lostAfterTicks: number;
  /** How fast a lost drone's keep-out volume grows, m/s. It is not parked. */
  lostHazardGrowth: number;
  lostHazardCap: number;
  cruiseSpeed: number;
  verticalSpeed: number;
  /** Lowest transit altitude. The choreography floor must sit above the whole band. */
  transitBaseAltitude: number;
  /** Vertical spacing between transit bands. Must clear the commanded spacing. */
  transitLaneSpacing: number;
  /** Transit bands per direction. A band carries one aircraft at a time, which is
   *  what makes transit separation a reservation rather than a search. */
  transitBands: number;
  /** Seconds of slack the engine keeps above the declared reserve and the flight home. */
  returnMarginSeconds: number;
  maxCommandRetries: number;
  /** How much faster than bare demand the engine issues rotation tickets. Above
   *  1.0 it brings drones home before their pack forces it, which is what buys
   *  the reserve margin at touchdown. */
  rotationPacing: number;
  /** Minimum time a drone holds a slot before it is eligible for rotation, ticks. */
  minSlotTicks: number;
  /** How long an aircraft may hold for a band, a pad or a blocked column before
   *  the engine gives up and brings it down where it is. Without this an aircraft
   *  can hold a transit band for the rest of the show and starve the rotation. */
  stallTicks: number;
  /** Consecutive on-station reports outside the declared error volume before the
   *  engine calls a contract violation rather than a software fault. */
  accuracyAuditTicks: number;
  accuracyAuditTolerance: number;
};

export const defaultEngineConfig: EngineConfig = {
  minimumSeparation: 2,
  bodyRadius: 0.25,
  lostAfterTicks: 15,
  lostHazardGrowth: 3,
  lostHazardCap: 40,
  cruiseSpeed: 8,
  verticalSpeed: 4,
  transitBaseAltitude: 15,
  transitLaneSpacing: 3.5,
  transitBands: 8,
  returnMarginSeconds: 25,
  maxCommandRetries: 20,
  rotationPacing: 1.1,
  minSlotTicks: 300,
  stallTicks: 600,
  accuracyAuditTicks: 10,
  accuracyAuditTolerance: 1.05,
};

/**
 * The transit pipeline. A band is a reserved cruise altitude held by one
 * aircraft at a time; the staging layer sits above the band stack and below the
 * choreography, and exists so that the long vertical leg into a slot does not
 * hold a band the whole way. Band-hold time is what sets transit capacity, so
 * that separation is the difference between a fleet of 50 and a fleet of 200.
 */
export type Phase =
  | 'grid'
  | 'on-pad'
  | 'launch-ascent'
  | 'climb-out'
  | 'cruise-out'
  | 'rise-to-stage'
  | 'await-slot'
  | 'rise-to-slot'
  | 'on-station'
  | 'await-departure'
  | 'descend-to-stage'
  | 'descend-to-band'
  | 'cruise-in'
  | 'descend-to-pad'
  | 'swapping'
  | 'contingency-land'
  | 'grounded'
  | 'faulted'
  | 'lost';

const AIRBORNE_PHASES: readonly Phase[] = [
  'launch-ascent',
  'climb-out',
  'cruise-out',
  'rise-to-stage',
  'await-slot',
  'rise-to-slot',
  'on-station',
  'await-departure',
  'descend-to-stage',
  'descend-to-band',
  'cruise-in',
  'descend-to-pad',
  'contingency-land',
];

export type EventKind =
  | 'launch'
  | 'relief-launched'
  | 'relief-unavailable'
  | 'band-unavailable'
  | 'pad-occupied'
  | 'dock-expired'
  | 'diverted'
  | 'slot-vacated'
  | 'slot-filled'
  | 'substitution'
  | 'return-due'
  | 'dock-accepted'
  | 'dock-refused'
  | 'dock-late'
  | 'swap-complete'
  | 'drone-lost'
  | 'drone-fault'
  | 'command-refused'
  | 'escalated'
  | 'dropout'
  | 'hold-on-reserve'
  | 'transit-held'
  | 'contract-violation'
  | 'geofence-breach'
  | 'separation-breach'
  | 'descent-conflict'
  | 'reserve-breach'
  | 'abort';

export type EngineEvent = { tick: number; kind: EventKind; droneId: number; detail: string };

type Assignment = {
  id: number;
  phase: Phase;
  /** Slot this drone holds, or -1. */
  slot: number;
  /** Slot it is on its way to, or -1. */
  targetSlot: number;
  pad: number;
  cruiseAltitude: number;
  cruiseIndex: number;
  commanded: [number, number, number];
  hasCommand: boolean;
  lastHeardTick: number;
  report: DroneTelemetry | null;
  lost: boolean;
  wasAirborne: boolean;
  accuracyStrikes: number;
  commandRefusals: number;
  escalated: boolean;
  dockRequestedTick: number;
  /** Why this drone holds a pad: it departed from one, or it is booked into one. */
  padRole: 'none' | 'departure' | 'arrival';
  dockAttempts: number;
  onStationSinceTick: number;
  dockArrivalTick: number;
  dockReadyTick: number;
  departAtTick: number;
  holdingSinceTick: number;
  /**
   * A vertical crossing in progress: the column other traffic must respect.
   *
   * A crossing is checked once, on entry, and then committed. Re-checking it
   * every tick deadlocks: two aircraft each inside the other's column both yield
   * for ever, and with a finite band pool the whole rotation stops. Committing
   * means every crossing finishes, so every aircraft waiting on one makes
   * progress.
   */
  crossing: { x: number; y: number; zLow: number; zHigh: number; radius: number } | null;
  /** Where an autolanding aircraft is putting itself down. */
  contingencyPoint: [number, number] | null;
};

export type Composability = {
  composable: boolean;
  rotationDemandPerMinute: number;
  rotationCapacityPerMinute: number;
  utilisation: number;
  onStationSeconds: number;
  outboundSeconds: number;
  noticeSeconds: number;
  rosterRequired: number;
  rosterAvailable: number;
  requiredSeparation: number;
  truthSeparationFloor: number;
  transitCapacityPerMinute: number;
  transitCeiling: number;
  reasons: string[];
  warnings: string[];
};

export type EngineSnapshot = {
  tick: number;
  onStation: number;
  airborne: number;
  inTransit: number;
  vacantSlots: number;
  lost: number;
  faulted: number;
  lowestReserveMargin: number;
  lowestReserveDrone: number;
  engineMinSeparation: number;
};

export class ShowEngine {
  readonly assignments: Assignment[] = [];
  readonly events: EngineEvent[] = [];
  readonly containment: ContainmentTracker;
  private readonly slotHolder: number[];
  private readonly slotIncoming: number[];
  private readonly bandOccupant: number[];
  private readonly evaluator: PlanEvaluator;
  private readonly requiredSeparationValue: number;
  private readonly truthFloorValue: number;
  private targets: Float32Array;
  private tick = 0;
  /**
   * Rotation tickets. An hour-long show launched as one wave has 50 packs
   * expiring in the same minute, and seven pads cannot absorb that. So the
   * engine spaces returns from the first tick, always calling down the aircraft
   * with the least energy left. De-synchronising the fleet is not an
   * optimisation here; without it the show cannot be flown at all.
   */
  private nextTicketTick = 0;
  private ticketIntervalTicks = 1;
  readonly rotationPlan: {
    demandPerMinute: number;
    ticketsPerMinute: number;
    intervalTicks: number;
  };
  aborted: { tick: number; mode: AbortMode; reason: string } | null = null;
  readonly contractViolations: { tick: number; droneId: number; detail: string }[] = [];
  readonly counters = {
    launches: 0,
    reliefLaunches: 0,
    reliefUnavailable: 0,
    substitutions: 0,
    dropouts: 0,
    docksRequested: 0,
    docksRefused: 0,
    commandRefusals: 0,
    escalations: 0,
    transitHolds: 0,
    diversions: 0,
    reserveBreaches: 0,
    separationBreaches: 0,
    descentConflicts: 0,
    geofenceBreaches: 0,
  };
  /** Dropouts are a regulatory metric, not an incident-log grep: contract 4. */
  readonly dropoutLog: { tick: number; droneId: number; reason: string }[] = [];
  /** Slot vacancy, the fidelity cost of rotating a fleet through a finite nest. */
  readonly vacancy = { peak: 0, totalSlotTicks: 0, ticks: 0 };

  constructor(
    readonly plan: ShowPlan,
    readonly fleet: FakeFleet,
    readonly nest: FakeNest,
    readonly fence: Geofence,
    readonly config: EngineConfig
  ) {
    this.evaluator = new PlanEvaluator(plan);
    this.containment = new ContainmentTracker(fence);
    // Contract 1: the engine must never command two drones into the same error
    // volume, and its spacing is computed from the *declared* volume. So the
    // commanded gap is the surface gap it wants to keep, plus both aircraft's
    // bodies, plus both error volumes. If the fleet delivers its declaration,
    // true centre-to-centre separation stays at or above `truthSeparationFloor`.
    this.requiredSeparationValue =
      config.minimumSeparation + 2 * fleet.declaredErrorVolume + 2 * config.bodyRadius;
    this.truthFloorValue = config.minimumSeparation + 2 * config.bodyRadius;
    this.slotHolder = new Array(plan.droneCount).fill(0);
    this.slotIncoming = new Array(plan.droneCount).fill(0);
    this.bandOccupant = new Array(config.transitBands * 2).fill(0);
    this.targets = this.evaluator.positions(0);
    for (let id = 1; id <= fleet.size; id++)
      this.assignments.push({
        id,
        phase: 'grid',
        slot: -1,
        targetSlot: -1,
        pad: -1,
        cruiseAltitude: 0,
        cruiseIndex: -1,
        commanded: [0, 0, 0],
        hasCommand: false,
        lastHeardTick: 0,
        report: fleet.telemetry(id),
        lost: false,
        wasAirborne: false,
        accuracyStrikes: 0,
        commandRefusals: 0,
        escalated: false,
        dockRequestedTick: -1,
        padRole: 'none',
        dockAttempts: 0,
        onStationSinceTick: -1,
        contingencyPoint: null,
        dockArrivalTick: -1,
        dockReadyTick: -1,
        departAtTick: -1,
        holdingSinceTick: -1,
        crossing: null,
      });
    // Drone j starts on the launch grid directly beneath slot j, because the show's
    // first cue is that grid: the mass launch is a vertical ascent and nothing else.
    for (const a of this.assignments) {
      const report = fleet.telemetry(a.id);
      if (report) a.commanded = [report.position[0], report.position[1], report.position[2]];
    }
    const planned = this.composability();
    const ticketsPerMinute = Math.min(
      planned.rotationCapacityPerMinute,
      planned.rotationDemandPerMinute * config.rotationPacing
    );
    this.ticketIntervalTicks = Math.max(
      1,
      Math.round((60 * TICK_HZ) / Math.max(0.01, ticketsPerMinute))
    );
    this.rotationPlan = {
      demandPerMinute: planned.rotationDemandPerMinute,
      ticketsPerMinute,
      intervalTicks: this.ticketIntervalTicks,
    };
  }

  /** The centre-to-centre gap the engine commands, from the declared error volume. */
  get requiredSeparation(): number {
    return this.requiredSeparationValue;
  }
  /** The true separation the commanded gap guarantees, if the fleet is honest. */
  get truthSeparationFloor(): number {
    return this.truthFloorValue;
  }
  /** Altitude of the highest transit band. The choreography has to stay above it. */
  get transitCeiling(): number {
    return (
      this.config.transitBaseAltitude +
      (this.config.transitBands * 2 - 1) * this.config.transitLaneSpacing
    );
  }
  /** Outbound staging altitude: where a relief waits for its slot to free. */
  get stageOutAltitude(): number {
    return this.transitCeiling + this.requiredSeparationValue;
  }
  /** Inbound staging altitude, above the outbound one so the two do not meet. */
  get stageInAltitude(): number {
    return this.stageOutAltitude + this.requiredSeparationValue;
  }
  /**
   * A relief waits this far from its slot's own column, toward the nest, so the
   * aircraft it is relieving can descend out of the slot without flying through
   * whoever is waiting to take it.
   */
  get stageOffset(): number {
    // Twice the commanded gap, not once: at exactly one gap the waiting aircraft
    // sits on the boundary of the descending one's column and rounding decides
    // whether either of them may move.
    return this.requiredSeparationValue * 2;
  }
  /** Seconds a transit band is held per movement. This sets transit capacity. */
  bandHoldSeconds(): number {
    const cruise = (this.plan.maxRadius + 80) / this.config.cruiseSpeed;
    const outbound = this.config.transitBaseAltitude / this.config.verticalSpeed + cruise;
    const inbound =
      (this.stageInAltitude - this.config.transitBaseAltitude) / this.config.verticalSpeed + cruise;
    return Math.max(outbound, inbound);
  }

  private record(kind: EventKind, droneId: number, detail: string) {
    this.events.push({ tick: this.tick, kind, droneId, detail });
  }

  /**
   * How far ahead a rotation is booked: one dock cycle, which is what contract 2
   * asks for.
   *
   * It is not quite enough. The relief is dispatched when the dock is booked and
   * needs about 30 s to reach the staging layer, while the aircraft it replaces
   * leaves roughly 5 s after the booking -- so the slot is empty for most of the
   * relief's outbound leg rather than just for the handover. Booking further
   * ahead fixes the gap and costs more than it saves: it takes the extra notice
   * out of every aircraft's time on station, which raises rotation demand, and
   * measured over an hour at 50 aircraft it took slot occupancy from 82% down to
   * 62%. The fix is to dispatch the relief earlier *without* moving the booking,
   * which this engine does not do yet.
   */
  private noticeSeconds(): number {
    return this.nest.requiredNoticeTicks * TICK_SECONDS;
  }
  /** Seconds to fly home from a slot: down to the inbound altitude, in, and down. */
  private homeSeconds(slotAltitude: number): number {
    const inbound = this.bandAltitude(this.config.transitBands);
    return (
      Math.abs(slotAltitude - inbound) / this.config.verticalSpeed +
      (this.plan.maxRadius + 80) / this.config.cruiseSpeed +
      inbound / this.config.verticalSpeed
    );
  }
  /** Band k's altitude. Outbound bands are 0..n-1, inbound n..2n-1. */
  private bandAltitude(band: number): number {
    return this.config.transitBaseAltitude + band * this.config.transitLaneSpacing;
  }
  /** How many bands in a direction are unoccupied. */
  private freeBands(direction: 'out' | 'in'): number {
    const from = direction === 'out' ? 0 : this.config.transitBands;
    const to = direction === 'out' ? this.config.transitBands : this.config.transitBands * 2;
    let free = 0;
    for (let band = from; band < to; band++) if (!this.bandOccupant[band]) free++;
    return free;
  }
  /** Lowest free band in a direction, or -1. Lowest-index-first, so it is stable. */
  private claimBand(direction: 'out' | 'in', id: number): number {
    const from = direction === 'out' ? 0 : this.config.transitBands;
    const to = direction === 'out' ? this.config.transitBands : this.config.transitBands * 2;
    for (let band = from; band < to; band++)
      if (!this.bandOccupant[band]) {
        this.bandOccupant[band] = id;
        return band;
      }
    return -1;
  }
  private outboundSeconds(): number {
    return (
      this.config.transitBaseAltitude / this.config.verticalSpeed +
      (this.plan.maxRadius + 80) / this.config.cruiseSpeed +
      (this.plan.maxAltitude - this.config.transitBaseAltitude) / this.config.verticalSpeed
    );
  }

  /**
   * Can this show be flown against this nest at all? Checked once, before the
   * first tick. Refusing here is the point of the beyond-capacity test: the
   * engine must not fly drones into a nest that cannot turn them around.
   */
  composability(): Composability {
    const capacity = this.nest.rotationCapacityPerMinute;
    const notice = this.noticeSeconds();
    const outbound = this.outboundSeconds();
    const onStation = Math.max(
      0,
      this.fleet.airSeconds -
        this.fleet.reserveSeconds -
        outbound -
        notice -
        this.config.returnMarginSeconds
    );
    // A show that fits inside one pack generates no rotation at all, and sizing
    // its ground system against a steady-state figure it never reaches would
    // refuse shows that are perfectly flyable. Where the show *does* outlive a
    // pack, the figure is the sustained one -- the rate the nest has to keep up
    // with, not an average softened by the first free period on station.
    const rotates = this.plan.durationSeconds > onStation;
    const demand = !rotates
      ? 0
      : onStation > 0
        ? (this.plan.droneCount * 60) / onStation
        : Infinity;
    const period = outbound + onStation + notice + this.nest.medianDockToReadyTicks * TICK_SECONDS;
    const rosterRequired = !rotates
      ? this.plan.droneCount + this.fleet.maxSimultaneousLoss
      : onStation > 0
        ? Math.ceil((this.plan.droneCount * period) / onStation) + this.fleet.maxSimultaneousLoss
        : Number.MAX_SAFE_INTEGER;
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (!Number.isFinite(demand) || demand > capacity)
      reasons.push(
        `Rotation demand ${demand.toFixed(2)}/min exceeds nest capacity ${capacity.toFixed(2)}/min. ` +
          `One pack buys ${onStation.toFixed(0)} s on station after a ${this.fleet.reserveSeconds.toFixed(0)} s reserve, ` +
          `${outbound.toFixed(0)} s outbound and ${notice.toFixed(0)} s of dock notice. Refusing to compose.`
      );
    if (rosterRequired > this.fleet.size)
      reasons.push(
        `Roster of ${this.fleet.size} is short of the ${rosterRequired} airframes a ` +
          `${period.toFixed(0)} s rotation period needs to keep ${this.plan.droneCount} on station.`
      );
    if (this.plan.maxRadius > this.fence.zones['flight-area'].radius)
      reasons.push(
        `Choreography reaches ${this.plan.maxRadius.toFixed(1)} m, outside the ` +
          `${this.fence.zones['flight-area'].radius} m Flight Area.`
      );
    if (this.plan.maxAltitude > this.fence.zones['flight-area'].ceiling)
      reasons.push(
        `Choreography reaches ${this.plan.maxAltitude.toFixed(1)} m, above the ` +
          `${this.fence.zones['flight-area'].ceiling} m Flight Area ceiling.`
      );
    // Transit capacity is a separate ceiling from the nest's. A band carries one
    // aircraft at a time, so the engine can only move so many drones in and out
    // per minute however many pads the nest has.
    const legSeconds = this.bandHoldSeconds();
    const transitCapacity = (this.config.transitBands * 60) / legSeconds;
    if (demand > transitCapacity)
      reasons.push(
        `Transit capacity is ${transitCapacity.toFixed(2)} drones/min: ${this.config.transitBands} bands ` +
          `per direction, each carrying one aircraft for a ${legSeconds.toFixed(0)} s leg. Rotation demand ` +
          `is ${demand.toFixed(2)}/min. Adding bands needs ${this.config.transitLaneSpacing} m of altitude ` +
          `each, and the stack already reaches ${this.transitCeiling.toFixed(1)} m. Refusing to compose.`
      );
    if (this.plan.minAltitude < this.stageInAltitude + this.requiredSeparationValue)
      reasons.push(
        `The choreography's floor is ${this.plan.minAltitude.toFixed(1)} m; the transit band stack reaches ` +
          `${this.transitCeiling.toFixed(1)} m and the inbound staging layer sits at ` +
          `${this.stageInAltitude.toFixed(1)} m. A show cannot fly through its own ingress corridors.`
      );
    if (this.config.transitLaneSpacing < this.requiredSeparationValue)
      reasons.push(
        `Transit bands are ${this.config.transitLaneSpacing} m apart, closer than the ` +
          `${this.requiredSeparationValue.toFixed(2)} m the engine commands between aircraft.`
      );
    if (transitCapacity < demand * 1.5)
      warnings.push(
        `Transit capacity ${transitCapacity.toFixed(1)}/min is less than 1.5x the ${demand.toFixed(1)}/min ` +
          `demand, so a held band will delay a rotation.`
      );
    const utilisation = demand / capacity;
    if (!rotates)
      warnings.push(
        `This show fits inside one pack (${onStation.toFixed(0)} s on station against a ` +
          `${this.plan.durationSeconds.toFixed(0)} s show), so no aircraft rotates and the nest is ` +
          `not exercised.`
      );
    if (utilisation > 0.95 && utilisation <= 1)
      warnings.push(
        `Rotation utilisation is ${(utilisation * 100).toFixed(1)}%. There is no margin for a late pad.`
      );
    return {
      composable: reasons.length === 0,
      rotationDemandPerMinute: demand,
      rotationCapacityPerMinute: capacity,
      utilisation,
      onStationSeconds: onStation,
      outboundSeconds: outbound,
      noticeSeconds: notice,
      rosterRequired,
      rosterAvailable: this.fleet.size,
      requiredSeparation: this.requiredSeparationValue,
      truthSeparationFloor: this.truthFloorValue,
      transitCapacityPerMinute: transitCapacity,
      transitCeiling: this.transitCeiling,
      reasons,
      warnings,
    };
  }

  /** One planning tick. Reads telemetry, decides, commands. */
  step(tick: number): EngineSnapshot {
    this.tick = tick;
    this.targets = this.evaluator.positions(tick * TICK_SECONDS);
    this.readTelemetry();
    this.handleLosses();
    if (!this.aborted) {
      if (tick === 0) this.massLaunch();
      this.manageSlots();
      this.scheduleRotation();
      this.breakStalls();
    }
    this.commandAll();
    return this.snapshot();
  }

  // --- telemetry ----------------------------------------------------------

  private readTelemetry() {
    for (const a of this.assignments) {
      const report = this.fleet.telemetry(a.id);
      if (report && report.tick > a.lastHeardTick) {
        a.lastHeardTick = report.tick;
        a.report = report;
      }
      if (!a.report) continue;
      if (a.report.state === 'fault' && a.phase !== 'faulted') {
        this.record('drone-fault', a.id, `Reported fault in phase ${a.phase}.`);
        this.releaseDrone(a, 'faulted');
      }
      this.auditAccuracy(a);
    }
  }

  /**
   * A drone that keeps reporting itself further from its own commanded position
   * than the fleet's declared error volume allows is not an engine defect. It is
   * contract 1 being broken, and the run says so in those words.
   */
  private auditAccuracy(a: Assignment) {
    if (a.phase !== 'on-station' || !a.hasCommand || !a.report) return;
    if (a.report.tick !== this.tick) return;
    // An aircraft that is refusing commands is not failing to hold a position it
    // accepted, so it is not evidence about the fleet's declared accuracy.
    if (a.commandRefusals > 0) return;
    const declared = Math.max(a.report.reportedAccuracy, this.fleet.declaredErrorVolume);
    const deviation = Math.hypot(
      a.report.position[0] - a.commanded[0],
      a.report.position[1] - a.commanded[1],
      a.report.position[2] - a.commanded[2]
    );
    if (deviation <= declared * this.config.accuracyAuditTolerance) {
      if (a.accuracyStrikes > 0) a.accuracyStrikes--;
      return;
    }
    a.accuracyStrikes++;
    if (a.accuracyStrikes !== this.config.accuracyAuditTicks) return;
    const detail =
      `CONTRACT 1 VIOLATION: drone ${a.id} declares ${declared.toFixed(2)} m position accuracy and has ` +
      `reported ${deviation.toFixed(2)} m from its own commanded position for ` +
      `${this.config.accuracyAuditTicks} consecutive ticks. The engine's safety spacing of ` +
      `${this.requiredSeparationValue.toFixed(2)} m is computed from the declared figure, so this voids the ` +
      `separation guarantee for the whole fleet. This is a fleet contract failure, not a software fault, ` +
      `and must not be filed as one.`;
    this.contractViolations.push({ tick: this.tick, droneId: a.id, detail });
    this.record('contract-violation', a.id, detail);
    this.abort('land-in-place', `Contract 1 violation by drone ${a.id}.`);
  }

  private handleLosses() {
    let active = 0;
    for (const a of this.assignments) {
      const stale = this.tick - a.lastHeardTick;
      if (!a.lost && stale > this.config.lostAfterTicks && a.phase !== 'grid') {
        a.lost = true;
        this.record(
          'drone-lost',
          a.id,
          `No report for ${(stale * TICK_SECONDS).toFixed(1)} s in phase ${a.phase}. Treated as lost, ` +
            `not stationary: its last known position becomes a keep-out volume that grows at ` +
            `${this.config.lostHazardGrowth} m/s, because an aircraft that stopped talking did not stop moving.`
        );
        this.releaseDrone(a, 'lost');
      }
      if (a.lost && a.wasAirborne) active++;
    }
    if (!this.aborted && active > this.fleet.maxSimultaneousLoss)
      this.abort(
        'land-in-place',
        `${active} aircraft lost at once, above the declared max_simultaneous_loss of ` +
          `${this.fleet.maxSimultaneousLoss}. Stopping is the correct outcome here, and this is the only ` +
          `case in the matrix where it is.`
      );
  }

  /** Free a drone's slot, pad and cruise altitude. */
  private releaseDrone(a: Assignment, phase: Phase) {
    if (a.slot >= 0 && this.slotHolder[a.slot] === a.id) {
      this.slotHolder[a.slot] = 0;
      this.record('slot-vacated', a.id, `Slot ${a.slot} vacated: ${phase}.`);
    }
    if (a.targetSlot >= 0 && this.slotIncoming[a.targetSlot] === a.id)
      this.slotIncoming[a.targetSlot] = 0;
    a.slot = -1;
    a.targetSlot = -1;
    this.releaseCruise(a);
    if (a.pad >= 0 && (phase === 'lost' || phase === 'faulted' || phase === 'contingency-land')) {
      this.nest.relinquish(a.pad, a.id);
      a.pad = -1;
      a.padRole = 'none';
    }
    a.crossing = null;
    a.phase = phase;
  }

  private releaseCruise(a: Assignment) {
    if (a.cruiseIndex >= 0 && this.bandOccupant[a.cruiseIndex] === a.id)
      this.bandOccupant[a.cruiseIndex] = 0;
    a.cruiseIndex = -1;
  }

  // --- launch and slots ---------------------------------------------------

  /** The mass launch: drone j rises vertically from the grid into slot j. */
  private massLaunch() {
    for (let slot = 0; slot < this.plan.droneCount; slot++) {
      const a = this.assignments[slot];
      if (!a || !a.report || a.report.state !== 'ready') continue;
      a.targetSlot = slot;
      a.phase = 'launch-ascent';
      a.wasAirborne = true;
      this.slotIncoming[slot] = a.id;
      this.counters.launches++;
    }
    this.record(
      'launch',
      0,
      `Mass launch: ${this.counters.launches} aircraft ascending vertically from the launch grid into ` +
        `the opening grid cue. No lateral movement, so the ascent columns are separated by the grid itself.`
    );
  }

  private manageSlots() {
    // A holder that is no longer flying its slot gives it up.
    for (let slot = 0; slot < this.plan.droneCount; slot++) {
      const holder = this.slotHolder[slot];
      if (!holder) continue;
      const a = this.assignments[holder - 1];
      if (a.phase !== 'on-station' && a.phase !== 'await-departure') {
        this.slotHolder[slot] = 0;
        if (a.slot === slot) a.slot = -1;
      }
    }
    let vacant = 0;
    for (let slot = 0; slot < this.plan.droneCount; slot++) {
      if (this.slotHolder[slot]) continue;
      vacant++;
      if (this.slotIncoming[slot]) continue;
      // Nothing is on its way: find a relief now. This is the substitution path for
      // a drone that faulted or went quiet, as well as the ordinary refill.
      this.dispatchRelief(slot, 'substitution');
    }
    this.vacancy.peak = Math.max(this.vacancy.peak, vacant);
    this.vacancy.totalSlotTicks += vacant;
    this.vacancy.ticks++;
  }

  /**
   * Send a ready drone to a slot, from a nest pad after a swap or from its own
   * launch-grid position if it has not flown yet. Returns the drone id, or 0.
   *
   * The grid is a departure point and not just an initial condition: without
   * that, the relief pool is empty until the first pack swap completes, and a
   * show's first rotation has nothing to hand its slots to.
   */
  private dispatchRelief(slot: number, kind: 'relief-launched' | 'substitution'): number {
    for (const a of this.assignments) {
      if (a.lost || a.targetSlot >= 0 || a.slot >= 0) continue;
      if (a.phase !== 'on-pad' && a.phase !== 'grid') continue;
      if (!a.report || a.report.state !== 'ready') continue;
      if (a.report.energyRemaining < this.fleet.airSeconds * 0.9) continue;
      if (a.pad >= 0 && this.nest.padState(a.pad) === 'fault') continue;
      const corridor: Vec3 =
        a.pad >= 0 ? this.nest.corridor(a.pad) : [a.report.position[0], a.report.position[1], 0];
      const target = this.slotPosition(slot);
      const band = this.claimBand('out', a.id);
      if (band < 0) continue;
      const altitude = this.bandAltitude(band);
      if (
        !this.columnClear(corridor[0], corridor[1], 0, altitude, a.id) ||
        !this.stepClear(corridor[0], corridor[1], altitude, a.id)
      ) {
        this.bandOccupant[band] = 0;
        continue;
      }
      a.targetSlot = slot;
      a.phase = 'climb-out';
      a.cruiseAltitude = altitude;
      a.cruiseIndex = band;
      a.wasAirborne = true;
      a.holdingSinceTick = -1;
      if (a.pad >= 0) a.padRole = 'departure';
      this.slotIncoming[slot] = a.id;
      this.counters.launches++;
      if (kind === 'relief-launched') this.counters.reliefLaunches++;
      else this.counters.substitutions++;
      this.record(
        kind,
        a.id,
        `${a.pad >= 0 ? `Pad ${a.pad}` : 'Launch grid'} to slot ${slot} via outbound band ${band} at ` +
          `${altitude.toFixed(1)} m; slot target ${target.map((v) => v.toFixed(0)).join('/')}.`
      );
      return a.id;
    }
    this.counters.reliefUnavailable++;
    return 0;
  }

  private slotPosition(slot: number): Vec3 {
    return [this.targets[slot * 3], this.targets[slot * 3 + 1], this.targets[slot * 3 + 2]];
  }

  // --- rotation -----------------------------------------------------------

  private scheduleRotation() {
    const notice = this.nest.requiredNoticeTicks;
    const urgent = this.noticeSeconds() + this.config.returnMarginSeconds;
    // One paced ticket per interval, to the hungriest aircraft on station.
    if (this.tick >= this.nextTicketTick && this.freeBands('in') > 0) {
      const candidate = this.hungriestOnStation();
      if (candidate)
        this.nextTicketTick =
          this.tick + (this.requestDock(candidate, notice) ? this.ticketIntervalTicks : TICK_HZ);
    }
    for (const a of this.assignments) {
      if (a.phase !== 'on-station' && a.phase !== 'await-departure') continue;
      if (!a.report) continue;
      // A booking this aircraft could not take up has expired at the nest. Drop
      // it and start again rather than flying home to a pad that was re-let.
      if (
        a.padRole === 'arrival' &&
        a.dockArrivalTick >= 0 &&
        this.tick > a.dockArrivalTick + this.nest.noShowTicks
      ) {
        this.record(
          'dock-expired',
          a.id,
          `Booking on pad ${a.pad} expired: never left slot ${a.slot} in time. Re-planning.`
        );
        a.pad = -1;
        a.padRole = 'none';
        a.dockArrivalTick = -1;
        a.departAtTick = -1;
        a.dockRequestedTick = -1;
        a.phase = 'on-station';
      }
      const margin = a.report.energyRemaining - this.fleet.reserveSeconds;
      // Out of pace and nearly out of pack: ask every second regardless of the
      // ticket clock. A refusal here is the nest saying the show was composed
      // beyond its throughput, and the drone holds on its reserve, not past it.
      if (a.phase === 'on-station' && margin <= urgent) {
        const retryDue = a.dockRequestedTick < 0 || this.tick - a.dockRequestedTick >= TICK_HZ;
        if (retryDue && !this.requestDock(a, notice) && a.holdingSinceTick < 0)
          a.holdingSinceTick = this.tick;
      }
      // Holding past the point where the drone can still reach the ground above
      // its reserve is not an option. It lands where it is: a counted dropout.
      if (margin <= a.commanded[2] / this.config.verticalSpeed + 2) {
        this.dropout(a, 'reserve reached while holding for a pad');
        continue;
      }
      const homeNow = this.homeSeconds(a.commanded[2]);
      if (a.phase === 'on-station' && a.holdingSinceTick >= 0 && margin <= homeNow + 2)
        this.record(
          'hold-on-reserve',
          a.id,
          `Held ${((this.tick - a.holdingSinceTick) * TICK_SECONDS).toFixed(1)} s for a pad; ` +
            `${margin.toFixed(0)} s above reserve against a ${homeNow.toFixed(0)} s flight home.`
        );
    }
  }

  /**
   * The on-station drone with the least energy left and no dock booked, provided
   * it is close enough to needing a pack that rotating it is not waste.
   *
   * Without that horizon the pacing clock rotates whoever is hungriest even when
   * the whole fleet is full, and the show burns pack cycles -- and magazine --
   * for nothing. The horizon is one full pass of the ticket queue plus the dock
   * notice: if an aircraft could not wait for its turn to come round again, it is
   * eligible now.
   */
  private hungriestOnStation(): Assignment | null {
    const horizon =
      this.noticeSeconds() +
      this.config.returnMarginSeconds +
      (this.plan.droneCount * 60) / Math.max(0.01, this.rotationPlan.ticketsPerMinute);
    let best: Assignment | null = null;
    for (const a of this.assignments) {
      if (a.phase !== 'on-station' || !a.report || a.lost) continue;
      if (a.padRole === 'arrival') continue;
      if (this.tick - a.onStationSinceTick < this.config.minSlotTicks) continue;
      if (a.report.energyRemaining - this.fleet.reserveSeconds > horizon) continue;
      if (!best || a.report.energyRemaining < best.report!.energyRemaining) best = a;
    }
    return best;
  }

  /** Ask the nest for a pad, and start the handover if it says yes. */
  private requestDock(a: Assignment, notice: number): boolean {
    if (a.dockRequestedTick === this.tick) return false;
    a.dockRequestedTick = this.tick;
    a.dockAttempts++;
    this.counters.docksRequested++;
    const margin = a.report ? a.report.energyRemaining - this.fleet.reserveSeconds : 0;
    const decision = this.nest.requestDock({
      droneId: a.id,
      arrivalTick: this.tick + notice,
      noticeTicks: notice,
    });
    if (!decision.accepted) {
      this.counters.docksRefused++;
      this.record(
        'dock-refused',
        a.id,
        `Nest refused: ${decision.reason}. Holding on station with ${margin.toFixed(0)} s above ` +
          `reserve. The hold ends at reserve, not past it.`
      );
      return false;
    }
    a.pad = decision.pad;
    a.padRole = 'arrival';
    a.dockArrivalTick = this.tick + notice;
    a.dockReadyTick = decision.readyAtTick;
    const home = this.homeSeconds(a.commanded[2]);
    a.departAtTick = Math.max(this.tick, a.dockArrivalTick - Math.ceil(home * TICK_HZ));
    a.phase = 'await-departure';
    a.holdingSinceTick = -1;
    this.record(
      'dock-accepted',
      a.id,
      `Pad ${decision.pad} (module ${decision.module}); ready at tick ${decision.readyAtTick}; ` +
        `leaving slot ${a.slot} at tick ${a.departAtTick} with ${margin.toFixed(0)} s above reserve.`
    );
    const quoted = (decision.readyAtTick - a.dockArrivalTick) * TICK_SECONDS;
    const median = this.nest.medianDockToReadyTicks * TICK_SECONDS;
    if (quoted > median * 1.2)
      this.record(
        'dock-late',
        a.id,
        `Nest quoted ${quoted.toFixed(1)} s against a ${median.toFixed(1)} s median. Re-planned ` +
          `against the quote, not the median: a pad that says it will be slow is believed.`
      );
    // The relief goes out now, so the slot is covered before the holder leaves.
    if (a.slot >= 0 && !this.slotIncoming[a.slot]) this.dispatchRelief(a.slot, 'relief-launched');
    return true;
  }

  /**
   * Nothing waits for ever. An aircraft stuck holding a transit band, a pad or a
   * blocked column is not just its own problem: it is holding a resource the
   * rotation needs, so the engine brings it down and counts the dropout rather
   * than letting one stall spread through the fleet.
   */
  private breakStalls() {
    for (const a of this.assignments) {
      if (a.lost) continue;
      // The reserve is a floor for *every* airborne aircraft, in every phase, not
      // just for one waiting on a pad. A drone held up on the way home can run
      // itself into its reserve just as surely as one held on station, so the
      // check is the same everywhere: the moment it can no longer reach the
      // ground and keep its reserve, it comes down where it is.
      if (a.report && AIRBORNE_PHASES.includes(a.phase) && a.phase !== 'contingency-land') {
        const margin = a.report.energyRemaining - this.fleet.reserveSeconds;
        const descent = a.commanded[2] / this.config.verticalSpeed + 4;
        if (margin <= descent) {
          this.dropout(
            a,
            `reserve floor reached in phase ${a.phase}: ${margin.toFixed(0)} s above reserve against ` +
              `a ${descent.toFixed(0)} s descent from ${a.commanded[2].toFixed(0)} m`
          );
          continue;
        }
      }
      if (a.holdingSinceTick < 0) continue;
      if (a.phase === 'on-station' || a.phase === 'await-departure') continue;
      if (this.tick - a.holdingSinceTick < this.config.stallTicks) continue;
      this.dropout(
        a,
        `held ${((this.tick - a.holdingSinceTick) * TICK_SECONDS).toFixed(0)} s in phase ${a.phase} ` +
          `without the band, pad or column it needed`
      );
    }
  }

  private dropout(a: Assignment, reason: string) {
    if (a.phase === 'contingency-land' || a.phase === 'grounded' || a.phase === 'lost') return;
    this.counters.dropouts++;
    this.dropoutLog.push({ tick: this.tick, droneId: a.id, reason });
    const at = a.commanded;
    // An aircraft on its reserve is coming down. If the column beneath it is
    // already claimed -- by another aircraft descending to a pad, or by another
    // autolanding -- it steps out of that column on the way down rather than
    // landing through it. Candidate directions are tried in an order that
    // depends on the aircraft's own id, so two aircraft autolanding in the same
    // place scatter instead of both choosing the same patch of ground.
    const d = 3 * this.requiredSeparationValue;
    const compass: [number, number][] = [
      [0, -d],
      [-d, 0],
      [d, 0],
      [0, d],
      [-d, -d],
      [d, -d],
    ];
    const clear = this.columnClear(at[0], at[1], 0, at[2], a.id);
    a.contingencyPoint = [at[0], at[1]];
    if (!clear) {
      const turn = a.id % compass.length;
      for (let i = 0; i < compass.length; i++) {
        const [dx, dy] = compass[(turn + i) % compass.length];
        if (this.columnClear(at[0] + dx, at[1] + dy, 0, at[2], a.id, d)) {
          a.contingencyPoint = [at[0] + dx, at[1] + dy];
          break;
        }
        if (i === compass.length - 1) a.contingencyPoint = [at[0] + dx, at[1] + dy];
      }
    }
    this.record(
      'dropout',
      a.id,
      `Autoland in place from ${a.commanded[2].toFixed(0)} m: ${reason}. Counted as a dropout, which ` +
        `contract 4 makes a reported figure rather than an incident-log entry.`
    );
    const point = a.contingencyPoint;
    this.releaseDrone(a, 'contingency-land');
    a.contingencyPoint = point;
    this.record(
      'dropout',
      a.id,
      clear
        ? `Landing straight down at ${at[0].toFixed(0)}/${at[1].toFixed(0)}.`
        : `Column below was claimed, so it is sidestepping to ` +
            `${a.contingencyPoint![0].toFixed(0)}/${a.contingencyPoint![1].toFixed(0)} before descending.`
    );
    a.crossing = {
      x: (at[0] + (point ? point[0] : at[0])) / 2,
      y: (at[1] + (point ? point[1] : at[1])) / 2,
      zLow: 0,
      zHigh: at[2],
      radius: this.requiredSeparationValue * 2.5,
    };
  }

  // --- commands -----------------------------------------------------------

  private commandAll() {
    const nextTime = (this.tick + 1) * TICK_SECONDS;
    for (const a of this.assignments) {
      if (a.lost || a.phase === 'faulted') continue;
      const target = this.nextPosition(a);
      if (!target) continue;
      const intent: TrajectoryIntent =
        a.phase === 'launch-ascent' || a.phase === 'climb-out'
          ? 'launch'
          : a.phase === 'descend-to-stage' ||
              a.phase === 'descend-to-band' ||
              a.phase === 'cruise-in' ||
              a.phase === 'descend-to-pad'
            ? 'return'
            : a.phase === 'contingency-land'
              ? 'contingency-land'
              : 'station';
      const accepted = this.fleet.ingestTrajectory(
        a.id,
        [{ time: nextTime, position: target }],
        intent
      );
      if (accepted) {
        // The commanded position only moves when the aircraft took the command.
        // Advancing it on a refusal would make the engine believe the aircraft is
        // somewhere it was told to go and declined to, and the accuracy audit
        // would then read a refused command as a position-accuracy shortfall --
        // reporting a contract violation against an aircraft whose only fault was
        // saying no.
        a.commanded = target;
        a.hasCommand = true;
        a.commandRefusals = 0;
        continue;
      }
      a.commandRefusals++;
      this.counters.commandRefusals++;
      if (a.commandRefusals === 1)
        this.record('command-refused', a.id, `Refused a trajectory in phase ${a.phase}.`);
      if (a.commandRefusals >= this.config.maxCommandRetries && !a.escalated) {
        a.escalated = true;
        this.counters.escalations++;
        this.record(
          'escalated',
          a.id,
          `Refused ${a.commandRefusals} consecutive commands (${(
            a.commandRefusals * TICK_SECONDS
          ).toFixed(
            1
          )} s). Escalating instead of retrying forever: the slot is released, the aircraft is ` +
            `treated as unavailable, and its volume stays reserved as a hazard.`
        );
        a.lost = true;
        this.releaseDrone(a, 'lost');
      }
    }
  }

  /** The next commanded position for a drone, advancing its phase as legs finish. */
  private nextPosition(a: Assignment): [number, number, number] | null {
    const step = this.config.verticalSpeed * TICK_SECONDS;
    const cruiseStep = this.config.cruiseSpeed * TICK_SECONDS;
    const here = a.commanded;
    switch (a.phase) {
      case 'grid':
      case 'on-pad':
      case 'swapping':
      case 'grounded': {
        // Parked. A drone still on the launch grid has no pad, so it holds the
        // position it reported at power-on.
        const at =
          a.pad >= 0
            ? this.nest.corridor(a.pad)
            : a.hasCommand
              ? (here as Vec3)
              : a.report
                ? a.report.position
                : ([0, 0, 0] as Vec3);
        return [at[0], at[1], 0];
      }
      case 'launch-ascent': {
        // The opening cue *is* the launch grid, so the mass launch is vertical and
        // nothing else: the ascent columns are separated by the grid itself.
        if (a.targetSlot < 0) return here;
        const slot = this.slotPosition(a.targetSlot);
        if (!a.crossing)
          a.crossing = {
            x: here[0],
            y: here[1],
            zLow: 0,
            zHigh: slot[2],
            radius: this.requiredSeparationValue,
          };
        const z = Math.min(slot[2], here[2] + step);
        if (slot[2] - z < 0.5) {
          this.takeSlot(a, a.targetSlot);
          return slot as [number, number, number];
        }
        return [here[0], here[1], z];
      }
      case 'climb-out': {
        const pad = this.nest.corridor(a.pad);
        if (!this.beginCrossing(a, pad[0], pad[1], 0, a.cruiseAltitude)) return here;
        const z = Math.min(a.cruiseAltitude, here[2] + step);
        if (a.cruiseAltitude - z < 1e-6) {
          a.phase = 'cruise-out';
          a.crossing = null;
        }
        return [pad[0], pad[1], z];
      }
      case 'cruise-out': {
        if (a.targetSlot < 0) return here;
        const hold = this.stagePoint(a.targetSlot);
        const moved = this.cruiseStep(a, hold[0], hold[1], cruiseStep);
        if (moved) return moved;
        a.phase = 'rise-to-stage';
        return [hold[0], hold[1], a.cruiseAltitude];
      }
      case 'rise-to-stage': {
        if (a.targetSlot < 0) return here;
        const hold = this.stagePoint(a.targetSlot);
        if (!this.beginCrossing(a, hold[0], hold[1], here[2], this.stageOutAltitude)) return here;
        // The band goes back in the pool here: the long climb towards a slot must
        // not hold a cruise altitude, or transit capacity collapses to one
        // aircraft per band per trip and altitude becomes the only way to buy it.
        this.releaseCruise(a);
        const z = Math.min(this.stageOutAltitude, here[2] + step);
        if (this.stageOutAltitude - z < 1e-6) {
          a.phase = 'await-slot';
          a.crossing = null;
        }
        return [hold[0], hold[1], z];
      }
      case 'await-slot': {
        if (a.targetSlot < 0) return here;
        const hold = this.stagePoint(a.targetSlot);
        const slot = this.slotPosition(a.targetSlot);
        // Wait beside the slot's own column until its holder has gone, then claim
        // the diagonal up into it. This wait is the handover vacancy the report
        // measures: a rotated show cannot be gapless, and pretending otherwise
        // would mean two aircraft in one slot.
        if (this.slotHolder[a.targetSlot] !== 0) {
          // Waiting for the aircraft it is relieving to leave is not a stall: it
          // is the handover working. Only a column that will not clear is.
          a.holdingSinceTick = -1;
          return [hold[0], hold[1], this.stageOutAltitude];
        }
        if (
          this.beginCrossing(
            a,
            (hold[0] + slot[0]) / 2,
            (hold[1] + slot[1]) / 2,
            this.stageOutAltitude,
            slot[2],
            this.requiredSeparationValue + this.stageOffset / 2
          )
        )
          a.phase = 'rise-to-slot';
        return [hold[0], hold[1], this.stageOutAltitude];
      }
      case 'rise-to-slot': {
        if (a.targetSlot < 0) return here;
        const slot = this.slotPosition(a.targetSlot);
        const z = here[2] + Math.min(step, Math.max(0, slot[2] - here[2]));
        const climbed =
          (z - this.stageOutAltitude) / Math.max(1e-6, slot[2] - this.stageOutAltitude);
        const hold = this.stagePoint(a.targetSlot);
        const x = hold[0] + (slot[0] - hold[0]) * Math.min(1, climbed);
        const y = hold[1] + (slot[1] - hold[1]) * Math.min(1, climbed);
        if (slot[2] - z < 0.5) {
          this.takeSlot(a, a.targetSlot);
          return slot as [number, number, number];
        }
        return [x, y, z];
      }
      case 'on-station':
        return a.slot >= 0 ? (this.slotPosition(a.slot) as [number, number, number]) : here;
      case 'await-departure': {
        const hold = a.slot >= 0 ? (this.slotPosition(a.slot) as [number, number, number]) : here;
        if (this.tick < a.departAtTick) return hold;
        // Do not give up the slot until there is a band to leave in. Holding the
        // slot costs this aircraft's reserve; leaving it with nowhere to go costs
        // the formation a gap and risks a stall at the staging layer.
        const band = this.claimBand('in', a.id);
        if (band < 0) {
          if (a.holdingSinceTick < 0) {
            a.holdingSinceTick = this.tick;
            this.record(
              'band-unavailable',
              a.id,
              `Keeping slot ${a.slot}: all ${this.config.transitBands} inbound transit bands are busy.`
            );
          }
          return hold;
        }
        a.cruiseIndex = band;
        a.cruiseAltitude = this.bandAltitude(band);
        a.phase = 'descend-to-stage';
        a.holdingSinceTick = -1;
        if (a.slot >= 0 && this.slotHolder[a.slot] === a.id) {
          this.slotHolder[a.slot] = 0;
          this.record('slot-vacated', a.id, `Slot ${a.slot} released for rotation.`);
        }
        a.slot = -1;
        return hold;
      }
      case 'descend-to-stage': {
        if (!this.beginCrossing(a, here[0], here[1], this.stageInAltitude, here[2])) return here;
        const z = Math.max(this.stageInAltitude, here[2] - step);
        if (z - this.stageInAltitude < 1e-6) {
          a.phase = 'descend-to-band';
          a.crossing = null;
        }
        return [here[0], here[1], z];
      }
      case 'descend-to-band': {
        if (a.pad < 0) {
          this.dropout(a, 'lost its pad reservation while descending');
          return here;
        }
        if (!this.beginCrossing(a, here[0], here[1], a.cruiseAltitude, here[2])) return here;
        const z = Math.max(a.cruiseAltitude, here[2] - step);
        if (z - a.cruiseAltitude < 1e-6) {
          a.phase = 'cruise-in';
          a.crossing = null;
        }
        return [here[0], here[1], z];
      }
      case 'cruise-in': {
        if (a.pad < 0) {
          this.dropout(a, 'lost its pad reservation on the way in');
          return here;
        }
        const pad = this.nest.corridor(a.pad);
        const moved = this.cruiseStep(a, pad[0], pad[1], cruiseStep);
        if (moved) return moved;
        // The booking promised the pad would be free on arrival. If this aircraft
        // is late -- a held band, a hazard on the way -- the pad may have been
        // re-let in the meantime, so the promise is checked rather than assumed.
        if (!this.nest.padAcceptsNow(a.pad, a.id)) {
          if (a.holdingSinceTick < 0) {
            a.holdingSinceTick = this.tick;
            this.record(
              'pad-occupied',
              a.id,
              `Arrived over pad ${a.pad} to find it ${this.nest.padState(a.pad)}. Holding at ` +
                `${a.cruiseAltitude.toFixed(1)} m rather than landing on another aircraft.`
            );
          }
          // Ask for any pad that is free now. An aircraft on short final cannot
          // give a dock cycle of notice and does not need to: the pad is free and
          // the pack is staged.
          if ((this.tick - a.holdingSinceTick) % (TICK_HZ * 5) === 0) {
            const diversion = this.nest.requestDiversion(a.id);
            if (diversion.accepted) {
              this.nest.relinquish(a.pad, a.id);
              a.pad = diversion.pad;
              a.dockReadyTick = diversion.readyAtTick;
              a.holdingSinceTick = -1;
              this.counters.diversions++;
              this.record(
                'diverted',
                a.id,
                `Diverted to pad ${diversion.pad}, free now, rather than holding on reserve for the ` +
                  `pad it booked.`
              );
            }
          }
          return [pad[0], pad[1], a.cruiseAltitude];
        }
        a.holdingSinceTick = -1;
        a.phase = 'descend-to-pad';
        return [pad[0], pad[1], a.cruiseAltitude];
      }
      case 'descend-to-pad': {
        if (a.pad < 0) {
          // No pad to descend to. This is a bookkeeping failure, not a flight
          // decision, and landing on the show origin is the worst possible guess.
          this.dropout(a, 'lost its pad reservation on final approach');
          return here;
        }
        const pad = this.nest.corridor(a.pad);
        // The pad's own corridor is the last thing to check and the easiest to
        // get wrong: a pad the nest calls free can still have the aircraft that
        // just left it in the air above, so the column is claimed, not assumed.
        if (!this.beginCrossing(a, pad[0], pad[1], 0, here[2])) return here;
        // With the column claimed, the band can go back into the pool.
        this.releaseCruise(a);
        const z = Math.max(0, here[2] - step);
        if (z <= 1e-6) {
          a.phase = 'swapping';
          a.crossing = null;
          this.nest.confirmArrival(a.pad, a.id, this.tick);
          this.fleet.markDocked(a.id, a.pad);
        }
        return [pad[0], pad[1], z];
      }
      case 'contingency-land': {
        // An autolanding aircraft is coming down whether or not the column is
        // clear, so its column stays claimed and everything else gets out of the
        // way. The alternative is a descent through traffic.
        const point = a.contingencyPoint ?? [here[0], here[1]];
        const dx = point[0] - here[0],
          dy = point[1] - here[1];
        const distance = Math.hypot(dx, dy);
        // Sidestep first, descend second. Descending while still drifting clear
        // means passing through the column it is trying to avoid, which is the
        // whole reason for the sidestep. A few metres of level flight is
        // affordable; descending into traffic is not.
        if (distance > 0.5) {
          const lateral = this.config.cruiseSpeed * TICK_SECONDS;
          return [
            distance <= lateral ? point[0] : here[0] + (dx / distance) * lateral,
            distance <= lateral ? point[1] : here[1] + (dy / distance) * lateral,
            here[2],
          ];
        }
        const z = Math.max(0, here[2] - step);
        if (z <= 1e-6) {
          a.phase = 'grounded';
          a.crossing = null;
        }
        return [point[0], point[1], z];
      }
      default:
        return null;
    }
  }

  /** Where a relief waits for a slot: beside its column, toward the nest. */
  private stagePoint(slot: number): Vec3 {
    const p = this.slotPosition(slot);
    return [p[0], p[1] - this.stageOffset, this.stageOutAltitude];
  }

  /** One horizontal step toward a target at the current cruise altitude, or null
   *  when the leg is finished. Holds in place rather than flying into a hazard. */
  private cruiseStep(
    a: Assignment,
    x: number,
    y: number,
    cruiseStep: number
  ): [number, number, number] | null {
    const here = a.commanded;
    const dx = x - here[0],
      dy = y - here[1];
    const distance = Math.hypot(dx, dy);
    if (distance <= cruiseStep) return null;
    const nx = here[0] + (dx / distance) * cruiseStep,
      ny = here[1] + (dy / distance) * cruiseStep;
    if (!this.stepClear(nx, ny, a.cruiseAltitude, a.id)) {
      this.counters.transitHolds++;
      if (a.holdingSinceTick < 0) {
        a.holdingSinceTick = this.tick;
        this.record(
          'transit-held',
          a.id,
          `Holding on a cruise leg in phase ${a.phase}: hazard ahead.`
        );
      }
      return [here[0], here[1], a.cruiseAltitude];
    }
    a.holdingSinceTick = -1;
    return [nx, ny, a.cruiseAltitude];
  }

  private takeSlot(a: Assignment, slot: number) {
    a.phase = 'on-station';
    a.onStationSinceTick = this.tick;
    a.slot = slot;
    a.targetSlot = -1;
    a.crossing = null;
    this.releaseCruise(a);
    if (this.slotIncoming[slot] === a.id) this.slotIncoming[slot] = 0;
    this.slotHolder[slot] = a.id;
    this.record('slot-filled', a.id, `On station in slot ${slot}.`);
  }

  /** A pack swap finished: the drone is ready on its pad. */
  swapComplete(droneId: number, pad: number) {
    const a = this.assignments[droneId - 1];
    if (!a) return;
    this.fleet.restorePack(droneId);
    a.phase = 'on-pad';
    a.pad = pad;
    a.padRole = 'departure';
    a.dockRequestedTick = -1;
    a.dockAttempts = 0;
    a.departAtTick = -1;
    this.record('swap-complete', droneId, `Ready on pad ${pad}.`);
  }

  /**
   * Release a pad once the aircraft that launched from it has cleared the
   * corridor. A pad booked for an *arrival* is not released here: that booking
   * is the whole point of giving the nest advance notice.
   */
  releaseClearedPads() {
    for (const a of this.assignments) {
      if (a.pad < 0 || a.padRole !== 'departure') continue;
      // The aircraft is still over its own pad at the start of the cruise, which
      // is why the nest adds its corridor-clear time on release rather than
      // taking a booking for the same instant.
      const cleared =
        a.phase === 'cruise-out' ||
        a.phase === 'rise-to-stage' ||
        a.phase === 'await-slot' ||
        a.phase === 'rise-to-slot' ||
        a.phase === 'on-station';
      if (cleared) {
        this.nest.relinquish(a.pad, a.id);
        a.pad = -1;
        a.padRole = 'none';
      }
    }
  }

  // --- separation helpers -------------------------------------------------

  /**
   * Claim a vertical column, once. Returns false if the column is busy, in which
   * case the aircraft holds and nothing is claimed.
   */
  private beginCrossing(
    a: Assignment,
    x: number,
    y: number,
    zFrom: number,
    zTo: number,
    radius = this.requiredSeparationValue
  ): boolean {
    if (a.crossing) return true;
    if (!this.columnClear(x, y, zFrom, zTo, a.id, radius)) {
      this.counters.transitHolds++;
      if (a.holdingSinceTick < 0) a.holdingSinceTick = this.tick;
      return false;
    }
    a.crossing = {
      x,
      y,
      zLow: Math.min(zFrom, zTo),
      zHigh: Math.max(zFrom, zTo),
      radius,
    };
    a.holdingSinceTick = -1;
    return true;
  }

  /**
   * Hazards: aircraft the engine cannot command, and columns being crossed.
   *
   * Takes an altitude *range*, not a point. Checking the middle of a column was a
   * real defect: an aircraft that had gone quiet sat at the top of the column the
   * engine then sent its relief up, and the midpoint sample missed it every time.
   */
  private hazardBlocks(
    exceptId: number,
    x: number,
    y: number,
    zLow: number,
    zHigh: number,
    radius = this.requiredSeparationValue
  ): boolean {
    const low = Math.min(zLow, zHigh),
      high = Math.max(zLow, zHigh);
    for (const other of this.assignments) {
      if (other.id === exceptId || !other.hasCommand) continue;
      if (other.lost) {
        // An aircraft that stopped reporting did not stop moving, so its keep-out
        // volume grows from where it was last seen for as long as it is missing.
        const age = (this.tick - other.lastHeardTick) * TICK_SECONDS;
        const grown = Math.min(
          this.config.lostHazardCap,
          radius + this.config.lostHazardGrowth * age
        );
        if (
          Math.hypot(x - other.commanded[0], y - other.commanded[1]) < grown &&
          other.commanded[2] >= low - grown &&
          other.commanded[2] <= high + grown
        )
          return true;
        continue;
      }
      if (other.phase === 'faulted') {
        // A faulted aircraft is descending under its own failsafe. Everything
        // below its last reported position is unusable until it is down.
        const p = other.report ? other.report.position : other.commanded;
        if (Math.hypot(x - p[0], y - p[1]) < radius && low <= p[2] + radius) return true;
        continue;
      }
      if (other.crossing) {
        const c = other.crossing;
        const gap = Math.max(radius, c.radius);
        if (Math.hypot(x - c.x, y - c.y) < gap && high >= c.zLow - gap && low <= c.zHigh + gap)
          return true;
      }
    }
    return false;
  }

  private stepClear(x: number, y: number, z: number, exceptId: number): boolean {
    return !this.hazardBlocks(exceptId, x, y, z, z);
  }

  /** Is the vertical column at (x, y) between these altitudes clear of traffic? */
  private columnClear(
    x: number,
    y: number,
    zLow: number,
    zHigh: number,
    exceptId: number,
    radius = this.requiredSeparationValue
  ): boolean {
    const low = Math.min(zLow, zHigh),
      high = Math.max(zLow, zHigh);
    const spacing = radius;
    for (const other of this.assignments) {
      if (other.id === exceptId || !other.hasCommand) continue;
      if (other.phase === 'on-pad' || other.phase === 'swapping' || other.phase === 'grounded')
        continue;
      if (other.phase === 'grid') continue;
      const p = other.commanded;
      if (Math.hypot(x - p[0], y - p[1]) >= spacing) continue;
      if (p[2] >= low - spacing && p[2] <= high + spacing) return false;
    }
    return !this.hazardBlocks(exceptId, x, y, low, high, radius);
  }

  // --- reporting ----------------------------------------------------------

  abort(mode: AbortMode, reason: string) {
    if (this.aborted) return;
    this.aborted = { tick: this.tick, mode, reason };
    const outcomes = this.fleet.abort(mode);
    const uncommanded = outcomes.filter((o) => o.disposition === 'uncommanded-descent').length;
    this.record(
      'abort',
      0,
      `${mode}: ${reason} ${outcomes.length} aircraft commanded, ${uncommanded} of them not under command.`
    );
  }

  noteBreach(
    kind: 'separation-breach' | 'descent-conflict' | 'geofence-breach' | 'reserve-breach',
    droneId: number,
    detail: string
  ) {
    if (kind === 'separation-breach') this.counters.separationBreaches++;
    if (kind === 'descent-conflict') this.counters.descentConflicts++;
    if (kind === 'geofence-breach') this.counters.geofenceBreaches++;
    if (kind === 'reserve-breach') this.counters.reserveBreaches++;
    this.record(kind, droneId, detail);
  }

  /**
   * A contract violation the harness saw from ground truth and the engine could
   * not. It goes in the event log so it appears in the trace, but not into the
   * engine's own list: the engine did not observe it, and a report that claimed
   * otherwise would overstate what telemetry can tell you.
   */
  noteHarnessContractViolation(droneId: number, detail: string) {
    this.record('contract-violation', droneId, detail);
  }

  private snapshot(): EngineSnapshot {
    let onStation = 0,
      airborne = 0,
      inTransit = 0,
      lost = 0,
      faulted = 0;
    let lowestReserveMargin = Infinity,
      lowestReserveDrone = 0,
      engineMinSeparation = Infinity;
    const reports: DroneTelemetry[] = [];
    for (const a of this.assignments) {
      if (a.lost) lost++;
      if (a.phase === 'faulted') faulted++;
      if (a.phase === 'on-station') onStation++;
      if (!AIRBORNE_PHASES.includes(a.phase) || a.lost) continue;
      airborne++;
      if (a.phase !== 'on-station' && a.phase !== 'await-departure') inTransit++;
      if (!a.report) continue;
      const margin = a.report.energyRemaining - this.fleet.reserveSeconds;
      if (margin < lowestReserveMargin) {
        lowestReserveMargin = margin;
        lowestReserveDrone = a.id;
      }
      reports.push(a.report);
    }
    for (let i = 0; i < reports.length; i++)
      for (let j = i + 1; j < reports.length; j++) {
        const p = reports[i].position,
          q = reports[j].position;
        const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
        if (d < engineMinSeparation) engineMinSeparation = d;
      }
    let vacant = 0;
    for (let slot = 0; slot < this.plan.droneCount; slot++) if (!this.slotHolder[slot]) vacant++;
    return {
      tick: this.tick,
      onStation,
      airborne,
      inTransit,
      vacantSlots: vacant,
      lost,
      faulted,
      lowestReserveMargin: Number.isFinite(lowestReserveMargin) ? lowestReserveMargin : 0,
      lowestReserveDrone,
      engineMinSeparation: Number.isFinite(engineMinSeparation) ? engineMinSeparation : 0,
    };
  }

  /**
   * Is this aircraft under the engine's command?
   *
   * A faulted aircraft is descending under its own failsafe, an aircraft that
   * stopped reporting is wherever it is, and one on a contingency landing is
   * coming down on its reserve. The engine can keep the aircraft it commands away
   * from each other; it cannot promise the same of one that is no longer taking
   * instructions. The run report keeps the two apart rather than scoring them the
   * same, and names the gap.
   */
  underCommand(id: number): boolean {
    const a = this.assignments[id - 1];
    if (!a) return false;
    return !a.lost && a.phase !== 'faulted' && a.phase !== 'contingency-land';
  }
  /** What the engine believes a drone is doing. For reports and breach detail. */
  phaseOf(id: number): Phase | 'unknown' {
    return this.assignments[id - 1]?.phase ?? 'unknown';
  }
  /** Phase histogram, for the run report's own account of where the fleet was. */
  phaseCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const a of this.assignments) counts[a.phase] = (counts[a.phase] ?? 0) + 1;
    return counts;
  }
  containmentMargins() {
    return this.containment.margins();
  }
  get zones() {
    return geofenceZones;
  }
}
