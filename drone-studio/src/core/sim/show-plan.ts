/**
 * An hour-long show, composed so that the choreography itself is safe.
 *
 * Two things here are load-bearing and neither is obvious.
 *
 * **The engine's `formation()` does not guarantee the project's own minimum
 * separation.** At 1,000 drones its `heart` places two aircraft 2 mm apart and
 * its `orbit` 0.81 m apart, at any scale that fits a field. `validateProject()`
 * is the thing that catches this -- it exists precisely to -- but nothing stops
 * a composer authoring it. So the plan builder picks shapes and scales that
 * clear the commanded spacing at the fleet size in question, and drops the ones
 * that cannot be made to.
 *
 * **A transition between two safe formations is not automatically safe.**
 * `formation()` keeps a stable array index as drone identity, so drone *i* flies
 * from shape A's point *i* to shape B's point *i* and paths cross. The builder
 * samples every candidate adjacency and only sequences pairs that stay clear.
 *
 * `projectSchema` also caps a single project at 1,800 seconds, so an hour-long
 * show is a *sequence* of projects. That cap is a real constraint of the engine
 * today and is recorded in the run report rather than worked around silently.
 */

import { ShowEvaluator } from '../animation';
import { formation, interpolate } from '../formations';
import {
  palettes,
  projectSchema,
  shapes,
  transitionEase,
  type Cue,
  type Project,
  type Shape,
} from '../model';
import { closestPair, ingressClearance } from './spacing';

export const TICK_HZ = 10;
export const TICK_SECONDS = 1 / TICK_HZ;
/** The engine's project model caps one project here. An hour needs two. */
export const MAX_PROJECT_SECONDS = 1800;

export type ShapeChoice = {
  shape: Shape;
  /** Scale needed for this shape to clear the commanded spacing at this fleet size. */
  scale: number;
  /** Formation minimum separation at that scale, metres. */
  minSeparation: number;
  /** Narrowest vertical ingress corridor in the formation, metres. */
  ingressClearance: number;
  /** Why a shape was dropped, when it was. */
  rejected?: string;
};

export type ShowPlan = {
  name: string;
  droneCount: number;
  bpm: number;
  segments: Project[];
  segmentStarts: number[];
  durationSeconds: number;
  /** Cue timings, so a test or a report can name a moment inside the show. */
  leadInSeconds: number;
  cueSeconds: number;
  transitionSeconds: number;
  maxAltitude: number;
  minAltitude: number;
  maxRadius: number;
  peakSpeed: number;
  /** Composition evidence: what the builder checked and what it rejected. */
  composition: {
    commandedSpacing: number;
    shapes: ShapeChoice[];
    usedShapes: Shape[];
    worstFormationSeparation: number;
    worstIngressClearance: number;
    worstTransitionSeparation: number;
    transitionSamples: number;
    rejectedAdjacencies: number;
  };
};

export type ShowPlanOptions = {
  droneCount: number;
  showSeconds: number;
  /** Centre-to-centre spacing the engine will command. Composition must clear it. */
  commandedSpacing: number;
  /** Lowest altitude the choreography may reach. Keeps the show above the transit band. */
  floor: number;
  /** Highest altitude the choreography may reach. */
  ceiling?: number;
  bpm?: number;
  cueSeconds?: number;
  transitionSeconds?: number;
  /** The opening cue holds long enough for the mass launch to finish. */
  leadInSeconds?: number;
  maxScale?: number;
};

const REFERENCE_SCALE = 70;

function cueFor(shape: Shape, scale: number, altitude: number, index: number): Cue {
  return {
    id: `cue-${index.toString().padStart(4, '0')}`,
    name: `Scene ${index + 1}`,
    shape,
    palette: palettes[index % palettes.length],
    duration: 40,
    transition: 30,
    transitionEasing: 'smooth',
    scale,
    altitude,
  };
}

/** Formation separation for one shape at one scale. */
function formationSeparation(shape: Shape, scale: number, count: number, probe: number): number {
  const positions = formation(cueFor(shape, scale, 100, 0), count);
  const pair = closestPair(positions, probe);
  return pair ? pair.distance : Infinity;
}

function formationIngress(shape: Shape, scale: number, count: number, spacing: number): number {
  return ingressClearance(formation(cueFor(shape, scale, 100, 0), count), spacing);
}

/** Choose a scale per shape, and drop the shapes that cannot clear the spacing. */
export function chooseShapes(
  count: number,
  commandedSpacing: number,
  maxScale: number
): ShapeChoice[] {
  const probe = Math.max(commandedSpacing * 8, 20);
  return shapes.map((shape) => {
    const reference = formationSeparation(shape, REFERENCE_SCALE, count, probe);
    if (!Number.isFinite(reference))
      return {
        shape,
        scale: REFERENCE_SCALE,
        minSeparation: reference,
        ingressClearance: 0,
        rejected: `no pair within the ${probe.toFixed(0)} m probe, so its spacing cannot be measured`,
      };
    // Separation scales linearly with the cue's scale, so the needed scale is a
    // ratio. Add 5% so the choice is not sitting exactly on the limit.
    const needed = (REFERENCE_SCALE * commandedSpacing * 1.05) / reference;
    const scale = Math.max(REFERENCE_SCALE, Math.ceil(needed));
    if (scale > maxScale)
      return {
        shape,
        scale,
        minSeparation: reference,
        ingressClearance: 0,
        rejected:
          `needs scale ${scale} to clear ${commandedSpacing.toFixed(2)} m at ${count} drones ` +
          `(${reference.toFixed(3)} m at scale ${REFERENCE_SCALE}), above the ${maxScale} m budget`,
      };
    const ingress = formationIngress(shape, scale, count, commandedSpacing);
    if (ingress < commandedSpacing)
      return {
        shape,
        scale,
        minSeparation: formationSeparation(shape, scale, count, probe),
        ingressClearance: ingress,
        rejected:
          `leaves only ${ingress.toFixed(2)} m of vertical ingress corridor at scale ${scale}: an ` +
          `aircraft hovers under another, so neither can be rotated out without flying through its ` +
          `neighbour. A rotated show needs a clear column beneath every slot`,
      };
    return {
      shape,
      scale,
      minSeparation: formationSeparation(shape, scale, count, probe),
      ingressClearance: ingress,
    };
  });
}

/** Is the straight blend from one formation to another clear throughout? */
function transitionSeparation(
  from: ShapeChoice,
  to: ShapeChoice,
  count: number,
  samples: number,
  probe: number,
  spacing: number
): { separation: number; ingress: number } {
  const a = formation(cueFor(from.shape, from.scale, 100, 0), count);
  const b = formation(cueFor(to.shape, to.scale, 100, 1), count);
  let separation = Infinity,
    ingress = Infinity;
  for (let step = 0; step <= samples; step++) {
    const blended = interpolate(a, b, transitionEase(step / samples, 'smooth'));
    const pair = closestPair(blended, probe);
    if (pair && pair.distance < separation) separation = pair.distance;
    ingress = Math.min(ingress, ingressClearance(blended, spacing));
  }
  return { separation, ingress };
}

/** A deterministic hour: no RNG, so two runs of the same options are the same show. */
export function buildShowPlan(options: ShowPlanOptions): ShowPlan {
  const bpm = options.bpm ?? 120;
  const cueSeconds = options.cueSeconds ?? 40;
  // Long blends, because they have to be. The endpoint distance between two of
  // these formations is most of the stage, and the engine's own analytic peak for
  // a minimum-jerk blend is 1.875 x distance / duration: a 12-second transition
  // would ask for roughly 19 m/s, well past the 8 m/s the project declares. The
  // choreography is composed to live inside its own limits, which is what
  // `validateProject()` is for.
  const transitionSeconds = options.transitionSeconds ?? 30;
  const leadInSeconds = options.leadInSeconds ?? 120;
  const maxScale = options.maxScale ?? 120;
  const beat = 60 / bpm;
  for (const value of [cueSeconds, transitionSeconds, leadInSeconds])
    if (
      Math.abs(value / beat - Math.round(value / beat)) > 1e-9 ||
      Math.abs(value * TICK_HZ - Math.round(value * TICK_HZ)) > 1e-9
    )
      throw new Error('Cue timings must be whole beats and whole ticks.');

  const probe = Math.max(options.commandedSpacing * 8, 20);
  const choices = chooseShapes(options.droneCount, options.commandedSpacing, maxScale);
  const usable = choices.filter((c) => !c.rejected);
  // The opening cue is the launch grid, so the grid shape has to survive. If it
  // cannot clear the spacing, no fleet of this size can be launched this way.
  const opening = usable.find((c) => c.shape === 'grid');
  if (!opening)
    throw new Error(
      `No launch grid clears ${options.commandedSpacing.toFixed(2)} m at ${options.droneCount} drones ` +
        `within a scale of ${maxScale} m.`
    );
  const samples = Math.max(8, Math.round(transitionSeconds * TICK_HZ) / 4);
  // One adjacency check per ordered pair, not per cue: altitude varies between
  // cues and a rigid z offset cancels out of every pairwise distance, so only
  // the shape and scale pair matter.
  const adjacency = new Map<string, number>();
  let rejectedAdjacencies = 0;
  const safeAfter = (from: ShapeChoice, to: ShapeChoice): number => {
    const key = `${from.shape}>${to.shape}`;
    let worst = adjacency.get(key);
    if (worst === undefined) {
      const measured = transitionSeparation(
        from,
        to,
        options.droneCount,
        samples,
        probe,
        options.commandedSpacing
      );
      // A transition is only usable if it keeps both the spacing *and* every
      // slot's ingress corridor: a rotation can start at any moment, including
      // the middle of a blend.
      worst = Math.min(measured.separation, measured.ingress);
      adjacency.set(key, worst);
    }
    return worst;
  };

  const sequence: ShapeChoice[] = [opening];
  const totalCues = Math.max(2, Math.ceil((options.showSeconds - leadInSeconds) / cueSeconds) + 1);
  let worstTransition = Infinity;
  while (sequence.length < totalCues) {
    const current = sequence[sequence.length - 1];
    let chosen: ShapeChoice | null = null;
    // Walk the usable shapes in a fixed rotation from the current one, taking the
    // first adjacency that stays clear. Repeating a shape is always clear, so the
    // walk cannot get stuck.
    const start = usable.findIndex((c) => c.shape === current.shape);
    for (let offset = 1; offset <= usable.length; offset++) {
      const candidate = usable[(start + offset) % usable.length];
      if (candidate.shape === current.shape) continue;
      const worst = safeAfter(current, candidate);
      if (worst >= options.commandedSpacing) {
        chosen = candidate;
        worstTransition = Math.min(worstTransition, worst);
        break;
      }
      rejectedAdjacencies++;
    }
    sequence.push(chosen ?? current);
  }

  const cueSpan = options.ceiling
    ? Math.min(4, Math.max(0, (options.ceiling - options.floor) / 8))
    : 4;
  const cues: Cue[] = sequence.map((choice, index) => {
    const cue = cueFor(choice.shape, choice.scale, 0, index);
    // Altitude walks a small fixed cycle so the show uses its volume. A rigid z
    // offset does not change any pairwise distance, so it cannot break spacing.
    cue.altitude = options.floor + 0.5 * choice.scale + (index % 4) * cueSpan;
    cue.duration = index === 0 ? leadInSeconds : cueSeconds;
    cue.transition = index === 0 ? 0 : transitionSeconds;
    return cue;
  });

  const segments: Project[] = [];
  const segmentStarts: number[] = [];
  let index = 0,
    elapsed = 0;
  while (index < cues.length) {
    const slice: Cue[] = [];
    let span = 0;
    while (index < cues.length && span + cues[index].duration <= MAX_PROJECT_SECONDS) {
      span += cues[index].duration;
      slice.push(cues[index++]);
    }
    // The first cue of a later segment has no incoming blend: the blend happened
    // at the end of the previous one, and a project cannot reach across the cut.
    segments.push(
      projectSchema.parse({
        version: 1,
        id: `hour-show-${segments.length}`,
        revision: 0,
        name: `Hour show, part ${segments.length + 1}`,
        droneCount: options.droneCount,
        bpm,
        cues: slice,
        limits: {
          minimumSeparation: Math.min(20, Math.max(0.5, options.commandedSpacing)),
          maxSpeed: 8,
          maxAcceleration: 4,
          maxAltitude: options.ceiling ?? 200,
          radius: 160,
        },
      })
    );
    segmentStarts.push(elapsed);
    elapsed += span;
  }

  const plan: ShowPlan = {
    name: 'Hour show',
    droneCount: options.droneCount,
    bpm,
    segments,
    segmentStarts,
    durationSeconds: elapsed,
    leadInSeconds,
    cueSeconds,
    transitionSeconds,
    maxAltitude: 0,
    minAltitude: 0,
    maxRadius: 0,
    peakSpeed: 0,
    composition: {
      commandedSpacing: options.commandedSpacing,
      shapes: choices,
      usedShapes: [...new Set(sequence.map((c) => c.shape))].sort(),
      worstFormationSeparation: Math.min(...usable.map((c) => c.minSeparation)),
      worstIngressClearance: Math.min(...usable.map((c) => c.ingressClearance)),
      worstTransitionSeparation: Number.isFinite(worstTransition) ? worstTransition : -1,
      transitionSamples: samples,
      rejectedAdjacencies,
    },
  };
  measureEnvelope(plan);
  return plan;
}

/** Commanded envelope of the choreography itself, before any aircraft error. */
function measureEnvelope(plan: ShowPlan) {
  const evaluator = new PlanEvaluator(plan);
  let maxAltitude = 0,
    minAltitude = Infinity,
    maxRadius = 0,
    peakSpeed = 0;
  let previous: Float32Array | null = null;
  // One sample per second: transitions are 12 s and smooth, so an extremum
  // cannot hide between samples by more than rounding.
  for (let t = 0; t <= plan.durationSeconds; t += 1) {
    const p = evaluator.positions(t);
    for (let i = 0; i < p.length; i += 3) {
      maxAltitude = Math.max(maxAltitude, p[i + 2]);
      minAltitude = Math.min(minAltitude, p[i + 2]);
      maxRadius = Math.max(maxRadius, Math.hypot(p[i], p[i + 1]));
      if (previous)
        peakSpeed = Math.max(
          peakSpeed,
          Math.hypot(p[i] - previous[i], p[i + 1] - previous[i + 1], p[i + 2] - previous[i + 2])
        );
    }
    previous = p.slice();
  }
  plan.maxAltitude = maxAltitude;
  plan.minAltitude = minAltitude;
  plan.maxRadius = maxRadius;
  plan.peakSpeed = peakSpeed;
}

/**
 * Commanded formation positions at a show time, across segment boundaries.
 *
 * Segment-local time comes from the exact segment start rather than an
 * accumulator, so an hour of evaluation cannot drift against the audio clock.
 */
export class PlanEvaluator {
  private readonly ids: number[];
  private readonly evaluators: (ShowEvaluator | null)[];
  constructor(readonly plan: ShowPlan) {
    this.ids = Array.from({ length: plan.droneCount }, (_, i) => i + 1);
    this.evaluators = plan.segments.map(() => null);
  }
  locate(time: number): { segment: number; localTime: number } {
    const t = Math.max(0, Math.min(this.plan.durationSeconds, time));
    let segment = 0;
    for (let i = this.plan.segments.length - 1; i >= 0; i--)
      if (t >= this.plan.segmentStarts[i]) {
        segment = i;
        break;
      }
    return { segment, localTime: t - this.plan.segmentStarts[segment] };
  }
  positions(time: number): Float32Array {
    const { segment, localTime } = this.locate(time);
    let evaluator = this.evaluators[segment];
    if (!evaluator) {
      evaluator = new ShowEvaluator(this.plan.segments[segment]);
      // Hold one evaluator at a time: each caches formations for its active cues,
      // and at 1,000 drones those buffers are the run's largest allocation.
      for (let i = 0; i < this.evaluators.length; i++) if (i !== segment) this.evaluators[i] = null;
      this.evaluators[segment] = evaluator;
    }
    return evaluator.samplePositions(localTime, this.ids);
  }
  /** Phase within the current beat, in [0, 1). The audio clock's own measure. */
  beatPhase(time: number): number {
    const beats = (time * this.plan.bpm) / 60;
    return beats - Math.floor(beats);
  }
}
