/**
 * Contract 4's four zones, and the Restricted Area as a free-fall calculation.
 *
 * The engine's own safety model is inter-aircraft spacing. A zoned boundary
 * sized by show parameters is a different object: the hard fence stops the
 * motors, so containment past that point is ballistic rather than navigational,
 * and the choreographer's altitude and speed choices set the ground footprint
 * directly.
 *
 * Figures here are provisional. Contract 4 is explicit that its numbers come
 * from waiver excerpts and need primary confirmation; what is modelled is the
 * shape.
 */

import { geofenceZones, type GeofenceZone, type Vec3 } from './contracts';

const G = 9.80665;
const FEET_PER_METRE = 3.280839895;

export type RestrictedAreaInputs = {
  /** The highest altitude the choreography reaches, metres. */
  maxAltitude: number;
  /** Horizontal speed at the moment power is cut, metres per second. */
  initialVelocity: number;
  /** Tailwind assumption, metres per second. */
  tailwind: number;
  /** Multiplier applied to the ballistic result. */
  safetyFactor: number;
};

export type RestrictedAreaWidth = {
  /** One waiver cites +10 m of restricted area per 100 ft of show altitude. */
  waiverRuleMetres: number;
  /** Horizontal travel after the hard fence cuts the motors, with safety factor. */
  ballisticMetres: number;
  /** The binding figure: the larger of the two. */
  metres: number;
  binding: 'waiver-rule' | 'ballistic';
  /** Free-fall time from max altitude, seconds. Shown so a reader can redo the sum. */
  fallSeconds: number;
};

/** +10 m per 100 ft, and the ballistic throw. Both reported; the larger binds. */
export function restrictedAreaWidth(i: RestrictedAreaInputs): RestrictedAreaWidth {
  const altitudeFeet = i.maxAltitude * FEET_PER_METRE;
  const waiverRuleMetres = 10 * (altitudeFeet / 100);
  const fallSeconds = Math.sqrt((2 * Math.max(0, i.maxAltitude)) / G);
  const ballisticMetres = i.safetyFactor * (i.initialVelocity + i.tailwind) * fallSeconds;
  const metres = Math.max(waiverRuleMetres, ballisticMetres);
  return {
    waiverRuleMetres,
    ballisticMetres,
    metres,
    binding: ballisticMetres >= waiverRuleMetres ? 'ballistic' : 'waiver-rule',
    fallSeconds,
  };
}

export type ZoneBounds = { radius: number; ceiling: number };

export type Geofence = {
  /** Cylinders about the show origin. Radius in metres, ceiling in metres AGL. */
  zones: Record<GeofenceZone, ZoneBounds>;
  restrictedArea: RestrictedAreaWidth;
  inputs: GeofenceInputs;
};

export type GeofenceInputs = {
  /** The choreography envelope the show is authored inside. */
  flightAreaRadius: number;
  flightAreaCeiling: number;
  /** Added to the flight area to get the soft fence. */
  softMargin: number;
  /** Added to the soft fence to get the hard fence. */
  hardMargin: number;
  /** Added to each zone's radius as a vertical allowance above the ceiling. */
  ceilingMargin: number;
  restricted: Omit<RestrictedAreaInputs, 'maxAltitude'>;
};

export function buildGeofence(i: GeofenceInputs, maxAltitude: number): Geofence {
  const restrictedArea = restrictedAreaWidth({ ...i.restricted, maxAltitude });
  const soft = i.flightAreaRadius + i.softMargin;
  const hard = soft + i.hardMargin;
  return {
    inputs: i,
    restrictedArea,
    zones: {
      'flight-area': { radius: i.flightAreaRadius, ceiling: i.flightAreaCeiling },
      'soft-fence': { radius: soft, ceiling: i.flightAreaCeiling + i.ceilingMargin },
      'hard-fence': { radius: hard, ceiling: i.flightAreaCeiling + 2 * i.ceilingMargin },
      // The Restricted Area is ground, not airspace: a footprint that has to be
      // kept clear of non-participating people. Its ceiling is the hard fence's.
      'restricted-area': {
        radius: hard + restrictedArea.metres,
        ceiling: i.flightAreaCeiling + 2 * i.ceilingMargin,
      },
    },
  };
}

/** Per-zone closest approach, in metres of remaining margin. Negative is a breach. */
export type ContainmentMargin = {
  zone: GeofenceZone;
  /** Smallest horizontal margin any aircraft reached. */
  horizontal: number;
  /** Smallest vertical margin any aircraft reached, against the zone ceiling. */
  vertical: number;
  /** The tick and drone that produced the horizontal figure. */
  atTick: number;
  droneId: number;
};

export class ContainmentTracker {
  private readonly best: ContainmentMargin[];
  constructor(readonly fence: Geofence) {
    this.best = geofenceZones.map((zone) => ({
      zone,
      horizontal: Infinity,
      vertical: Infinity,
      atTick: -1,
      droneId: 0,
    }));
  }
  observe(position: Vec3, droneId: number, tick: number): GeofenceZone[] {
    const radial = Math.hypot(position[0], position[1]);
    const breached: GeofenceZone[] = [];
    for (let i = 0; i < geofenceZones.length; i++) {
      const zone = geofenceZones[i];
      const bounds = this.fence.zones[zone];
      const horizontal = bounds.radius - radial;
      const vertical = bounds.ceiling - position[2];
      const record = this.best[i];
      // Strict improvement only, so ties keep the earliest tick and lowest id:
      // a report a reader can reproduce by replaying the trace.
      if (horizontal < record.horizontal) {
        record.horizontal = horizontal;
        record.atTick = tick;
        record.droneId = droneId;
      }
      if (vertical < record.vertical) record.vertical = vertical;
      // The restricted area is a ground footprint; aircraft are inside it by
      // construction, so only the flight boundaries can be breached in the air.
      if (zone !== 'restricted-area' && (horizontal < 0 || vertical < 0)) breached.push(zone);
    }
    return breached;
  }
  margins(): ContainmentMargin[] {
    return this.best.map((m) => ({ ...m }));
  }
}
