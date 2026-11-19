/**
 * Nest throughput, from the program's own arithmetic.
 *
 * This is a port of the subset of the hub's `tools/show_sizing.py` that the
 * simulated nest needs, so the fake nest's throughput is the figure the program
 * actually predicts rather than a number someone liked. `nest-sizing.test.ts`
 * pins it against the script's published output at 50, 200 and 1,000 airborne
 * drones; if the script changes, that test fails and this file follows it.
 *
 * At 50 airborne drones and 2C charging the script says: 7 pads, 5 modules,
 * a 65-slot magazine per module, 325 packs in rotation, 63 airframes.
 */

export type SizingInputs = {
  /** Drones in the air simultaneously. */
  airborne: number;
  /** Usable airborne minutes per pack. */
  airMinutes: number;
  /** Charge rate, C. 1C is one hour. */
  chargeCRate: number;
  /** Pack handling and staging either side of the charge. */
  queueMinutes: number;
  /** Drone descend + dock + swap + climb. */
  cycleMinutes: number;
  /** How long one visit occupies a pad. */
  dockMinutes: number;
  /** Airborne drones one deployable module serves. */
  moduleDrones: number;
};

export const defaultSizingInputs: SizingInputs = {
  airborne: 50,
  airMinutes: 6,
  chargeCRate: 2,
  queueMinutes: 3,
  cycleMinutes: 1.5,
  dockMinutes: 0.75,
  moduleDrones: 10,
};

export type GroundSystem = {
  /** Straight from the script. */
  chargeMinutes: number;
  packsInRotation: number;
  airframesNeeded: number;
  padsNeeded: number;
  modules: number;
  packSlotsPerModule: number;
  /** Derived for the nest fake, from the integer pad count the script rounds up to. */
  padsPerModule: number;
  /** Drones returned to `ready` per minute, per module: pads / dock time. */
  rotationCapacityPerModulePerMinute: number;
  rotationCapacityPerMinute: number;
  /** What the show asks of the nest: one pack per drone per air time. */
  rotationDemandPerMinute: number;
  /** Demand over capacity. Above 1.0 the engine must refuse to compose. */
  rotationUtilisation: number;
};

export function sizeGroundSystem(overrides: Partial<SizingInputs> = {}): GroundSystem {
  const i = { ...defaultSizingInputs, ...overrides };
  const chargeMinutes = 60 / i.chargeCRate;
  const packs = i.airborne * (1 + (chargeMinutes + i.queueMinutes) / i.airMinutes);
  const airframes = i.airborne * (1 + i.cycleMinutes / i.airMinutes);
  const pads = i.airborne * (i.dockMinutes / i.airMinutes);
  const modules = Math.ceil(i.airborne / i.moduleDrones);
  const padsNeeded = Math.ceil(pads);
  // The nest has whole pads. Capacity comes from the count that gets built, not
  // from the fractional demand figure -- which is why the baseline show has a
  // thin rotation margin rather than none at all.
  const padsPerModule = padsNeeded / modules;
  const capacityPerModule = padsPerModule / i.dockMinutes;
  const capacity = capacityPerModule * modules;
  const demand = i.airborne / i.airMinutes;
  return {
    chargeMinutes,
    packsInRotation: Math.ceil(packs),
    airframesNeeded: Math.ceil(airframes),
    padsNeeded,
    modules,
    packSlotsPerModule: Math.ceil(packs / modules),
    padsPerModule,
    rotationCapacityPerModulePerMinute: capacityPerModule,
    rotationCapacityPerMinute: capacity,
    rotationDemandPerMinute: demand,
    rotationUtilisation: demand / capacity,
  };
}
