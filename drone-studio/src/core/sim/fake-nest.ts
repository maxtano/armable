/**
 * The fake nest: contract 2, implemented against nothing.
 *
 * Contract 2 is the one the program is most likely to get wrong, because its
 * flaws only show at full scale -- so it gets a simulated implementation long
 * before a pad exists. Its throughput comes from `nest-sizing.ts`, which ports
 * the hub's own `tools/show_sizing.py`, rather than from a number someone liked.
 *
 * Two things here are deliberately awkward for the engine, because real pads
 * will be: `dock -> ready` is a distribution rather than a constant, and the
 * nest can refuse.
 */

import { Rng } from './rng';
import { TICK_HZ } from './show-plan';
import {
  padStates,
  type DockDecision,
  type DockRefusalReason,
  type DockRequest,
  type NestContract,
  type PadState,
  type Vec3,
} from './contracts';

export type FakeNestConfig = {
  pads: number;
  modules: number;
  packSlotsPerModule: number;
  /** Median dock -> ready latency in ticks. */
  dockToReadyMedianTicks: number;
  /** Log-normal sigma. Real pads are not punctual. */
  dockToReadySigma: number;
  /** The nest will not accept a drone with less notice than this: one dock cycle. */
  requiredNoticeTicks: number;
  /** Ticks to charge a spent pack, plus handling either side. */
  packTurnaroundTicks: number;
  /** Packs charged and staged when the show starts. */
  initialChargedPacks: number;
  /** Pad positions, ENU metres at ground level. */
  padPositions: readonly Vec3[];
  /** Radius of the reserved approach corridor around each pad. */
  corridorRadius: number;
  /** Ticks after a swap before the pad can take another arrival: the departing
   *  aircraft has to clear the corridor first. */
  corridorClearTicks: number;
  /** Ticks past a booked arrival before the nest writes the drone off and takes
   *  the pad back. A no-show must not hold a pad for the rest of the show. */
  noShowTicks: number;
};

type Booking = { droneId: number; arrivalTick: number; latencyTicks: number };

type Pad = {
  index: number;
  module: number;
  state: PadState;
  droneId: number;
  /** Tick the pack swap completes and the drone is `ready`. */
  readyAtTick: number;
  /** Tick the drone is expected to touch down. */
  arrivalTick: number;
  busyTicks: number;
  /**
   * Earliest tick a new arrival could have this pad.
   *
   * Contract 2 wants one dock cycle of advance notice *and* quotes a
   * `rotation_capacity` derived from how long a visit occupies a pad. Those two
   * are only consistent if notice books a pad forward instead of occupying it:
   * if a request held the physical pad from the moment it was made, effective
   * capacity would be halved. So the nest schedules, and the pad stays free for
   * whoever can still use it in the meantime.
   */
  freeFromTick: number;
  queue: Booking[];
};

export type NestRecord = {
  docksRequested: number;
  docksAccepted: number;
  docksRefused: number;
  refusalsByReason: Record<DockRefusalReason, number>;
  docksLate: number;
  /** Total lateness against the median the engine schedules on, in ticks. */
  latenessTicks: number;
  worstLatenessTicks: number;
  padBusyTicks: number;
  padTicks: number;
  chargedPackLow: number;
  swapsCompleted: number;
  /** Bookings whose aircraft never arrived. */
  noShows: number;
  diversionsRequested: number;
  diversionsAccepted: number;
  diversionsRefused: number;
};

export class FakeNest implements NestContract {
  private readonly padList: Pad[] = [];
  /** Completion ticks of packs on charge. Kept sorted: no map iteration anywhere. */
  private charging: number[] = [];
  private chargedPacks: number;
  private tickNow = 0;
  private readonly latency: Rng;
  /** Extra lateness injected for a specific drone's next swap. */
  private readonly injectedLateness = new Map<number, number>();
  readonly record: NestRecord = {
    docksRequested: 0,
    docksAccepted: 0,
    docksRefused: 0,
    refusalsByReason: {
      'no-free-pad': 0,
      'no-charged-pack': 0,
      'pad-fault': 0,
      'insufficient-notice': 0,
      'nest-closed': 0,
    },
    docksLate: 0,
    latenessTicks: 0,
    worstLatenessTicks: 0,
    padBusyTicks: 0,
    padTicks: 0,
    chargedPackLow: Number.POSITIVE_INFINITY,
    swapsCompleted: 0,
    noShows: 0,
    diversionsRequested: 0,
    diversionsAccepted: 0,
    diversionsRefused: 0,
  };
  private closed = false;

  constructor(
    readonly config: FakeNestConfig,
    rng: Rng,
    insertionOrder: 'natural' | 'reversed' = 'natural'
  ) {
    const order = Array.from({ length: config.pads }, (_, i) => i);
    if (insertionOrder === 'reversed') order.reverse();
    for (const index of order)
      this.padList.push({
        index,
        module: Math.floor((index * config.modules) / config.pads),
        state: 'free',
        droneId: 0,
        readyAtTick: -1,
        arrivalTick: -1,
        busyTicks: 0,
        freeFromTick: 0,
        queue: [],
      });
    this.padList.sort((a, b) => a.index - b.index);
    this.chargedPacks = config.initialChargedPacks;
    this.latency = rng.fork('nest-latency');
  }

  get pads(): number {
    return this.config.pads;
  }
  get modules(): number {
    return this.config.modules;
  }
  /**
   * Drones returned to `ready` per minute, per module.
   *
   * Contract 2 quotes this figure and separately promises a `dock -> ready`
   * latency. They are not the same number: a pad is unavailable for the swap
   * *and* for however long the departing aircraft needs to clear its corridor.
   * Advertising capacity from the swap time alone overstates it, so this figure
   * includes the corridor.
   */
  get rotationCapacityPerModulePerMinute(): number {
    const padsPerModule = this.config.pads / this.config.modules;
    const occupancyTicks = this.config.dockToReadyMedianTicks + this.config.corridorClearTicks;
    return padsPerModule / (occupancyTicks / (TICK_HZ * 60));
  }
  get rotationCapacityPerMinute(): number {
    return this.rotationCapacityPerModulePerMinute * this.config.modules;
  }
  get medianDockToReadyTicks(): number {
    return this.config.dockToReadyMedianTicks;
  }
  get requiredNoticeTicks(): number {
    return this.config.requiredNoticeTicks;
  }
  /** How long past a booked arrival the nest keeps a pad for a no-show. */
  get noShowTicks(): number {
    return this.config.noShowTicks;
  }

  padState(pad: number): PadState {
    return this.padList[pad]?.state ?? 'fault';
  }
  /** Can this aircraft put itself on that pad right now? */
  padAcceptsNow(pad: number, droneId: number): boolean {
    const slot = this.padList[pad];
    if (!slot || slot.state === 'fault') return false;
    return slot.state === 'free' || slot.droneId === droneId;
  }
  corridor(pad: number): Vec3 {
    return this.config.padPositions[pad] ?? [0, 0, 0];
  }
  /** Total packs the magazine holds, across modules. */
  get packCapacity(): number {
    return this.config.packSlotsPerModule * this.config.modules;
  }
  get chargedPacksAvailable(): number {
    return this.chargedPacks;
  }

  requestDock(request: DockRequest): DockDecision {
    this.record.docksRequested++;
    const refuse = (reason: DockRefusalReason): DockDecision => {
      this.record.docksRefused++;
      this.record.refusalsByReason[reason]++;
      return { accepted: false, reason };
    };
    if (this.closed) return refuse('nest-closed');
    if (request.noticeTicks < this.config.requiredNoticeTicks) return refuse('insufficient-notice');
    const working = this.padList.filter((p) => p.state !== 'fault');
    if (!working.length) return refuse('pad-fault');
    // Lowest pad index that will be free by the quoted arrival. Deterministic,
    // and it keeps the rotation record readable.
    const pad = working.find((p) => p.freeFromTick <= request.arrivalTick);
    if (!pad) return refuse('no-free-pad');
    if (this.chargedPacks <= 0) return refuse('no-charged-pack');
    this.chargedPacks--;
    const injected = this.injectedLateness.get(request.droneId) ?? 0;
    this.injectedLateness.delete(request.droneId);
    const sampled = Math.max(
      1,
      Math.round(
        this.latency.logNormal(this.config.dockToReadyMedianTicks, this.config.dockToReadySigma)
      )
    );
    const latencyTicks = sampled + injected;
    pad.queue.push({ droneId: request.droneId, arrivalTick: request.arrivalTick, latencyTicks });
    pad.queue.sort((a, b) => a.arrivalTick - b.arrivalTick || a.droneId - b.droneId);
    // The pad is unavailable from the arrival until the swap is done and the
    // aircraft has cleared the corridor.
    pad.freeFromTick = request.arrivalTick + latencyTicks + this.config.corridorClearTicks;
    const readyAtTick = request.arrivalTick + latencyTicks;
    const late = latencyTicks - this.config.dockToReadyMedianTicks;
    if (late > 0) {
      this.record.docksLate++;
      this.record.latenessTicks += late;
      this.record.worstLatenessTicks = Math.max(this.record.worstLatenessTicks, late);
    }
    this.record.docksAccepted++;
    return { accepted: true, pad: pad.index, module: pad.module, readyAtTick };
  }

  /**
   * A diversion: an aircraft already over the nest, whose booked pad was taken
   * while it was held up on the way in, asks for any pad that is free *now*.
   *
   * Contract 2 has no provision for this. It requires one dock cycle of advance
   * notice, which an aircraft on short final cannot give and does not need: the
   * pad is already free and the pack is already staged. The harness found this
   * gap, and this method is the smallest thing that fills it; contract 2 should
   * say so explicitly rather than leaving the engine to choose between landing
   * on an occupied pad and burning its reserve in a hold.
   */
  requestDiversion(droneId: number): DockDecision {
    this.record.diversionsRequested++;
    // A refused diversion is not a refused dock: the aircraft already had a
    // booking. Counting it as one would drown the rotation record in noise.
    const refuse = (reason: DockRefusalReason): DockDecision => {
      this.record.diversionsRefused++;
      return { accepted: false, reason };
    };
    if (this.closed) return refuse('nest-closed');
    const pad = this.padList.find(
      (p) => p.state === 'free' && !p.queue.some((b) => b.arrivalTick <= this.tickNow + 50)
    );
    if (!pad) return refuse('no-free-pad');
    if (this.chargedPacks <= 0) return refuse('no-charged-pack');
    this.chargedPacks--;
    const latencyTicks = Math.max(
      1,
      Math.round(
        this.latency.logNormal(this.config.dockToReadyMedianTicks, this.config.dockToReadySigma)
      )
    );
    pad.queue.push({ droneId, arrivalTick: this.tickNow, latencyTicks });
    pad.queue.sort((a, b) => a.arrivalTick - b.arrivalTick || a.droneId - b.droneId);
    pad.state = 'occupied';
    pad.droneId = droneId;
    pad.freeFromTick = this.tickNow + latencyTicks + this.config.corridorClearTicks;
    this.record.diversionsAccepted++;
    this.record.docksAccepted++;
    return {
      accepted: true,
      pad: pad.index,
      module: pad.module,
      readyAtTick: this.tickNow + latencyTicks,
    };
  }

  /** The drone has touched down on its pad. The swap begins. */
  confirmArrival(pad: number, droneId: number, tick: number) {
    const slot = this.padList[pad];
    if (!slot || slot.state === 'fault') return;
    // Match the booking to the aircraft that actually landed, not to whichever
    // booking is first in the queue: a late arrival must not take over someone
    // else's pack and leave two drones believing they hold one pad.
    const index = slot.queue.findIndex((b) => b.droneId === droneId);
    const booking = index >= 0 ? slot.queue.splice(index, 1)[0] : null;
    slot.state = 'swapping';
    slot.droneId = droneId;
    slot.arrivalTick = tick;
    // The swap starts when the aircraft is on the pad, not when it said it would
    // be: a drone that arrived late does not get a faster pad.
    slot.readyAtTick = tick + (booking ? booking.latencyTicks : this.config.dockToReadyMedianTicks);
    slot.freeFromTick = Math.max(
      slot.freeFromTick,
      slot.readyAtTick + this.config.corridorClearTicks
    );
  }

  /**
   * One aircraft gives up its claim on a pad: it has left after a swap, diverted
   * elsewhere, or been lost on the way in.
   *
   * It is named deliberately. A pad can be *booked* by one aircraft while
   * another is physically on it, so "release this pad" is not a safe operation:
   * releasing a pad that someone else is swapping on strands that aircraft on a
   * pad the nest thinks is empty. The claim is given up by name, and the pad is
   * only freed if this aircraft was the one holding it.
   */
  relinquish(pad: number, droneId: number) {
    const slot = this.padList[pad];
    if (!slot || slot.state === 'fault') return;
    const booked = slot.queue.filter((b) => b.droneId === droneId);
    if (booked.length) {
      slot.queue = slot.queue.filter((b) => b.droneId !== droneId);
      // The pack it was promised goes back on charge rather than disappearing.
      for (const _ of booked) this.charging.push(this.tickNow + this.config.packTurnaroundTicks);
      this.charging.sort((a, b) => a - b);
    }
    if (slot.droneId === droneId || slot.droneId === 0) {
      slot.state = 'free';
      slot.droneId = 0;
      slot.readyAtTick = -1;
      // The corridor still has to clear. Freeing a pad the instant an aircraft
      // starts its cruise lets the next arrival descend onto one that is still
      // leaving, which is a collision the engine cannot see coming.
      slot.freeFromTick = Math.max(this.tickNow, 0) + this.config.corridorClearTicks;
    }
    for (const booking of slot.queue)
      slot.freeFromTick = Math.max(
        slot.freeFromTick,
        booking.arrivalTick + booking.latencyTicks + this.config.corridorClearTicks
      );
  }

  /** Pads whose swap completed this tick, lowest pad first. */
  advance(tick: number): { pad: number; droneId: number }[] {
    this.tickNow = tick;
    // Packs come back from charge. The array is sorted, so this is order-free.
    while (this.charging.length && this.charging[0] <= tick) {
      this.charging.shift();
      if (this.chargedPacks < this.packCapacity) this.chargedPacks++;
    }
    this.record.chargedPackLow = Math.min(this.record.chargedPackLow, this.chargedPacks);
    const completed: { pad: number; droneId: number }[] = [];
    for (const pad of this.padList) {
      // A booking that never turned up is cancelled and its pack goes back on
      // charge. Otherwise one aircraft lost on the way home costs a pad for the
      // rest of the show.
      const expired = pad.queue.filter((b) => tick > b.arrivalTick + this.config.noShowTicks);
      if (expired.length) {
        pad.queue = pad.queue.filter((b) => tick <= b.arrivalTick + this.config.noShowTicks);
        this.record.noShows += expired.length;
        if (pad.state === 'occupied' && expired.some((b) => b.droneId === pad.droneId)) {
          pad.state = 'free';
          pad.droneId = 0;
        }
        for (const _ of expired) this.charging.push(tick + this.config.packTurnaroundTicks);
        this.charging.sort((a, b) => a - b);
        pad.freeFromTick =
          pad.state === 'free'
            ? Math.max(
                tick,
                ...pad.queue.map(
                  (b) => b.arrivalTick + b.latencyTicks + this.config.corridorClearTicks
                )
              )
            : pad.freeFromTick;
      }
      this.record.padTicks++;
      if (pad.state !== 'free') {
        pad.busyTicks++;
        this.record.padBusyTicks++;
      }
      // A pad whose booked arrival time has come is held *for that aircraft*, by
      // name. Marking it occupied without naming the drone makes the pad refuse
      // the very arrival it is waiting for, which deadlocks the rotation.
      if (pad.state === 'free') {
        const next = pad.queue.find((b) => b.arrivalTick <= tick);
        if (next) {
          pad.state = 'occupied';
          pad.droneId = next.droneId;
        }
      }
      if (pad.state === 'swapping' && pad.readyAtTick <= tick) {
        pad.state = 'occupied';
        completed.push({ pad: pad.index, droneId: pad.droneId });
        this.record.swapsCompleted++;
        const done = tick + this.config.packTurnaroundTicks;
        this.charging.push(done);
        this.charging.sort((a, b) => a - b);
      }
    }
    return completed;
  }

  // --- fault injection ----------------------------------------------------

  /** A pad goes down. Any drone on it is stranded; the engine must cope. */
  injectPadFault(pad: number) {
    const slot = this.padList[pad];
    if (slot) {
      slot.state = 'fault';
      slot.readyAtTick = -1;
    }
  }
  /** Starve the magazine, so the nest has to refuse. */
  setChargedPacks(count: number) {
    this.chargedPacks = Math.max(0, count);
  }
  /** The next swap for this drone takes longer than the nest advertised. */
  injectLateSwap(droneId: number, extraTicks: number) {
    this.injectedLateness.set(droneId, extraTicks);
  }
  close() {
    this.closed = true;
  }
  snapshot(): { pad: number; state: PadState; droneId: number; freeFromTick: number }[] {
    return this.padList.map((p) => ({
      pad: p.index,
      state: p.state,
      droneId: p.droneId,
      freeFromTick: p.freeFromTick,
    }));
  }
  padStateCounts(): Record<PadState, number> {
    const counts = Object.fromEntries(padStates.map((s) => [s, 0])) as Record<PadState, number>;
    for (const pad of this.padList) counts[pad.state]++;
    return counts;
  }
  get now(): number {
    return this.tickNow;
  }
}
