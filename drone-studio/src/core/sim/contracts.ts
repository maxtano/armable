/**
 * The arm boundaries, as types.
 *
 * These are the shapes of contracts 1, 2 and 4 in the Lucidity program hub's
 * `interfaces/README.md`, written down so the show engine can be developed and
 * tested against them before a pad or an aircraft exists. Nothing here models
 * flight dynamics, aerodynamics, radio or battery chemistry: those are
 * deliberately out of scope, and the harness tests the engine's *decisions*.
 */

export type Vec3 = readonly [number, number, number];

/** Contract 1: the state enum the engine's substitution logic runs on, entire. */
export const droneStates = ['ready', 'flying', 'returning', 'docked', 'charging', 'fault'] as const;
export type DroneState = (typeof droneStates)[number];

/** Contract 2: pad state per slot. */
export const padStates = ['free', 'occupied', 'swapping', 'fault'] as const;
export type PadState = (typeof padStates)[number];

/** The unit of choreography, timestamped. Times are show seconds. */
export type TrajectoryKeyframe = { time: number; position: Vec3 };
export type LightKeyframe = { time: number; rgb: Vec3; brightness: number };

export type DroneTelemetry = {
  id: number;
  state: DroneState;
  /** Where the drone *says* it is, local ENU metres. May differ from the truth. */
  position: Vec3;
  /** The position accuracy the drone claims, as a radius in metres. */
  reportedAccuracy: number;
  /** Usable airborne seconds remaining. Not volts — the engine schedules in seconds. */
  energyRemaining: number;
  /** The tick that produced this report. A stale tick means lost, never stationary. */
  tick: number;
};

export type AbortMode = 'land-in-place' | 'hold-position';

export type AbortDisposition = 'landing' | 'holding' | 'already-on-ground' | 'uncommanded-descent';

/** Every drone must produce one of these from every state. There is no refusal path. */
export type AbortOutcome = {
  id: number;
  mode: AbortMode;
  stateBefore: DroneState;
  disposition: AbortDisposition;
  note: string;
};

/**
 * Contract 1, show engine -> fleet. The engine may use nothing else about an
 * aircraft. In particular its safety spacing comes from `declaredErrorVolume`,
 * which is why a fleet that lies about that number is a contract violation and
 * not a software bug.
 */
export interface FleetContract {
  /** Airframes in the roster, airborne or not. */
  readonly size: number;
  /** Declared position error volume: radius in metres. A promise, not a measurement. */
  readonly declaredErrorVolume: number;
  /** Declared reserve: airborne seconds the engine may never command a drone below. */
  readonly reserveSeconds: number;
  /** How many drones may be lost at once before the show must stop. Declared. */
  readonly maxSimultaneousLoss: number;
  /** Fresh-pack endurance in usable airborne seconds. */
  readonly airSeconds: number;
  /** The latest report, or null if this drone has never reported. */
  telemetry(id: number): DroneTelemetry | null;
  /** Timestamped trajectory ingestion. Returns false if the drone refuses the command. */
  ingestTrajectory(id: number, keys: readonly TrajectoryKeyframe[]): boolean;
  /** Timestamped light keyframe ingestion. Returns false if the drone refuses. */
  ingestLights(id: number, keys: readonly LightKeyframe[]): boolean;
  /** Non-negotiable, and must succeed from any state. */
  abort(mode: AbortMode): AbortOutcome[];
}

export type DockRequest = {
  droneId: number;
  /** The tick the drone will arrive at the pad. */
  arrivalTick: number;
  /** Ticks of advance notice the engine is giving. Contract 2 wants >= one dock cycle. */
  noticeTicks: number;
};

export type DockRefusalReason =
  'no-free-pad' | 'no-charged-pack' | 'pad-fault' | 'insufficient-notice' | 'nest-closed';

export type DockDecision =
  | { accepted: true; pad: number; module: number; readyAtTick: number }
  | { accepted: false; reason: DockRefusalReason };

/**
 * Contract 2, nest -> show engine. The engine composes against throughput and
 * latency figures; it must never model the mechanism.
 */
export interface NestContract {
  readonly modules: number;
  readonly pads: number;
  /** Drones returned to `ready` per minute, per module. */
  readonly rotationCapacityPerModulePerMinute: number;
  /** Fleet-wide capacity, for composability checks. */
  readonly rotationCapacityPerMinute: number;
  /** Median dock -> ready latency in ticks. Real pads are not punctual; see the fake. */
  readonly medianDockToReadyTicks: number;
  /** The minimum notice the nest will accept, in ticks: one dock cycle. */
  readonly requiredNoticeTicks: number;
  requestDock(request: DockRequest): DockDecision;
  padState(pad: number): PadState;
  /** Reserved approach corridor centre for a pad, ENU metres at ground level. */
  corridor(pad: number): Vec3;
}

/** Contract 4: the four named zones, with the behaviour each violation triggers. */
export const geofenceZones = [
  'flight-area',
  'soft-fence',
  'hard-fence',
  'restricted-area',
] as const;
export type GeofenceZone = (typeof geofenceZones)[number];

export const zoneViolationBehaviour: Record<GeofenceZone, string> = {
  'flight-area': 'composition error: the choreography was authored outside its own envelope',
  'soft-fence': 'return to home or autoland',
  'hard-fence': 'motors stop',
  'restricted-area': 'ground footprint: containment is ballistic once the hard fence cuts motors',
};
