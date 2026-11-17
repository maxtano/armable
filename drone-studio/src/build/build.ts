import { z } from 'zod';
import { PART_BY_ID, PARTS, PROVEN, PROVEN_BY_ID, storeLinks, type Category, type Part, type Specs, type Video } from './catalog';

/**
 * A drone build: the person's goals and one slot per kind of part. The same code runs in the browser and behind
 * the assistant's tools, so a part added by either shows the same checks, cost and weight.
 */

/** Essentials make it fly, extras make it better, and gear is what you need to fly it. */
export type Group = 'essential' | 'extra' | 'gear';
export const SLOTS: { id: Category; label: string; gear?: boolean; needed?: boolean; extra?: boolean }[] = [
  { id: 'frame', label: 'Frame', needed: true }, { id: 'motors', label: 'Motors', needed: true }, { id: 'stack', label: 'Flight controller + ESC', needed: true },
  { id: 'props', label: 'Props', needed: true }, { id: 'battery', label: 'Battery', needed: true }, { id: 'receiver', label: 'Receiver', needed: true },
  { id: 'vtx', label: 'Video transmitter', needed: true }, { id: 'camera', label: 'Camera', needed: true }, { id: 'antenna', label: 'Video antenna' }, { id: 'gps', label: 'GPS', extra: true },
  { id: 'radio', label: 'Radio', gear: true }, { id: 'goggles', label: 'Goggles', gear: true }, { id: 'charger', label: 'Charger', gear: true },
];
export const SLOT_LABEL: Record<string, string> = Object.fromEntries([...SLOTS.map(s => [s.id, s.label]), ['other', 'Extra']]);
export const groupOf = (category: string): Group => category === 'other' || category === 'gps' ? 'extra' : GEAR_IDS.has(category) ? 'gear' : 'essential';
const GEAR_IDS = new Set(['radio', 'goggles', 'charger']);
const CATEGORIES = [...SLOTS.map(s => s.id), 'other'] as unknown as [Category, ...Category[]];
const GEAR = new Set(['radio', 'goggles', 'charger']);
export const STYLES = ['freestyle', 'cinematic', 'long-range', 'racing', 'whoop', 'other'] as const;

export interface Price { usd: number; store?: string; url?: string; at: number; by: string }
export interface Item {
  slot: string; category: Category; qty: number;
  /** A catalog part, or a part the person or assistant described. */
  part?: string;
  custom?: { brand?: string; name: string; weightG?: number; specs?: Specs; url?: string };
  price?: Price; owned?: boolean; note?: string; by: string; at: number;
}
export type Gear = 'radio' | 'goggles' | 'charger';
export interface Goal { style?: (typeof STYLES)[number]; propIn?: number; budgetUsd?: number; video?: Video; notes?: string; owns?: Gear[] }
export interface LogEntry { at: number; by: string; kind: 'note' | 'change'; text: string }
export interface Build { goal: Goal; items: Item[]; log: LogEntry[]; from?: string }
export const emptyBuild = (): Build => ({ goal: {}, items: [], log: [] });

const VIDEO = z.enum(['analog', 'dji', 'walksnail', 'hdzero']);
const goalSchema = z.object({
  style: z.enum(STYLES).optional(), propIn: z.number().min(1).max(13).optional(), budgetUsd: z.number().min(0).max(100000).optional(),
  video: VIDEO.optional(), notes: z.string().max(600).optional(), owns: z.array(z.enum(['radio', 'goggles', 'charger'])).max(3).optional(),
}).strict();
const specsSchema = z.object({
  propIn: z.number().optional(), stator: z.string().max(12).optional(), kv: z.number().optional(), cells: z.tuple([z.number(), z.number()]).optional(), thrustG: z.number().optional(),
  amps: z.number().optional(), series: z.number().optional(), mah: z.number().optional(), link: z.enum(['ELRS 2.4', 'ELRS 900', 'Crossfire']).optional(), video: VIDEO.optional(),
  mounts: z.array(z.enum(['30.5', '25.5', '20', 'whoop'])).optional(), includes: z.array(z.enum(['camera', 'antenna', 'receiver'])).optional(), chem: z.enum(['LiPo', 'LiHV', 'Li-ion']).optional(),
}).strict();
const url = z.string().max(500).refine(u => /^https:\/\//.test(u), 'Links must start with https://');
const slot = z.string().min(1).max(20).describe('A category, or other.N for an extra part');
export const buildOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('goal'), set: goalSchema }).strict(),
  z.object({ op: z.literal('add'), part: z.string().min(1).max(60), qty: z.number().int().min(1).max(50).optional(), note: z.string().max(300).optional() }).strict(),
  z.object({ op: z.literal('custom'), category: z.enum(CATEGORIES), name: z.string().min(1).max(80), brand: z.string().max(40).optional(), priceUsd: z.number().min(0).max(20000).optional(), url: url.optional(), store: z.string().max(40).optional(), weightG: z.number().min(0).max(5000).optional(), specs: specsSchema.optional(), qty: z.number().int().min(1).max(50).optional(), note: z.string().max(300).optional() }).strict(),
  z.object({ op: z.literal('remove'), slot }).strict(),
  z.object({ op: z.literal('qty'), slot, qty: z.number().int().min(1).max(50) }).strict(),
  z.object({ op: z.literal('price'), slot, usd: z.number().min(0).max(20000), store: z.string().max(40).optional(), url: url.optional() }).strict(),
  z.object({ op: z.literal('own'), slot, owned: z.boolean() }).strict(),
  z.object({ op: z.literal('note'), text: z.string().min(1).max(800) }).strict(),
  z.object({ op: z.literal('from'), build: z.string().min(1).max(60) }).strict(),
]);
export type BuildOp = z.infer<typeof buildOpSchema>;
export const BUILD_OPS_HINT = 'Build operations: {"op":"goal","set":{style,propIn,budgetUsd,video,owns,notes}}, {"op":"add","part":"<part id>"}, {"op":"custom","category","name","priceUsd","url"}, {"op":"remove","slot"}, {"op":"qty","slot","qty"}, {"op":"price","slot","usd","store","url"}, {"op":"own","slot","owned"}, {"op":"note","text"}, {"op":"from","build":"<proven id>"}. A slot is a category such as "motors".';

const itemSchema = z.object({
  slot: z.string().max(20), category: z.enum(CATEGORIES), qty: z.number().int().min(1).max(50), part: z.string().max(60).optional(),
  custom: z.object({ brand: z.string().max(40).optional(), name: z.string().max(80), weightG: z.number().optional(), specs: specsSchema.optional(), url: url.optional() }).strict().optional(),
  price: z.object({ usd: z.number(), store: z.string().max(40).optional(), url: url.optional(), at: z.number(), by: z.string().max(80) }).strict().optional(),
  owned: z.boolean().optional(), note: z.string().max(300).optional(), by: z.string().max(80), at: z.number(),
}).strict();
export const buildSchema = z.object({
  goal: goalSchema, items: z.array(itemSchema).max(40),
  log: z.array(z.object({ at: z.number(), by: z.string().max(80), kind: z.enum(['note', 'change']), text: z.string().max(800) }).strict()).max(300),
  from: z.string().max(60).optional(),
}).strict();

// ---- Resolving parts ---------------------------------------------------------------------------------------------

export interface Resolved { item: Item; name: string; brand: string; specs: Specs; weightG?: number; unitUsd?: number; priceSource: 'seen' | 'typical' | 'none'; links: { store: string; url: string }[]; blurb?: string; maker?: string }
export function resolve(item: Item): Resolved {
  const part = item.part ? PART_BY_ID.get(item.part) : undefined;
  const brand = part?.brand ?? item.custom?.brand ?? '', name = part?.name ?? item.custom?.name ?? item.part ?? 'Unknown part';
  const links = [...(item.price?.url ? [{ store: item.price.store ?? 'Seen at', url: item.price.url }] : []), ...(item.custom?.url && item.custom.url !== item.price?.url ? [{ store: 'Link', url: item.custom.url }] : []), ...storeLinks({ brand, name })];
  const unitUsd = item.price?.usd ?? part?.priceUsd;
  return { item, name, brand, specs: part?.specs ?? item.custom?.specs ?? {}, weightG: part?.weightG ?? item.custom?.weightG, unitUsd, priceSource: item.price ? 'seen' : unitUsd !== undefined ? 'typical' : 'none', links, blurb: part?.blurb, maker: part?.maker };
}
const label = (r: Resolved) => `${r.brand ? `${r.brand} ` : ''}${r.name}`;

// ---- Applying operations -----------------------------------------------------------------------------------------

export class BuildError extends Error {}
function findSlot(build: Build, slot: string): Item {
  const item = build.items.find(i => i.slot === slot);
  if (!item) throw new BuildError(`The build has nothing in "${slot}". Slots in use: ${build.items.map(i => i.slot).join(', ') || 'none'}.`);
  return item;
}
const nextOther = (build: Build) => { let n = 1; while (build.items.some(i => i.slot === `other.${n}`)) n++; return `other.${n}`; };
/** Put an item in its slot. One part per slot; "other" parts stack up. Returns what it replaced. */
function place(build: Build, item: Item): Item | undefined {
  if (item.category === 'other') { item.slot = nextOther(build); build.items.push(item); return undefined; }
  const at = build.items.findIndex(i => i.slot === item.slot);
  const old = at >= 0 ? build.items[at] : undefined;
  if (old) build.items[at] = item; else build.items.push(item);
  const order = (s: string) => { const i = SLOTS.findIndex(x => x.id === s.split('.')[0]); return i < 0 ? 99 : i; };
  build.items.sort((a, b) => order(a.slot) - order(b.slot));
  return old;
}

/** Apply operations in order and return a new build. All or nothing: an operation that fails changes nothing. */
export function applyBuildOps(input: Build, operations: unknown[], by: string, now = Date.now()): Build {
  const build: Build = structuredClone(input);
  const say = (text: string) => build.log.push({ at: now, by, kind: 'change', text });
  operations.forEach((raw, index) => {
    const parsed = buildOpSchema.safeParse(raw);
    if (!parsed.success) throw new BuildError(`Operation ${index + 1}: ${parsed.error.issues[0].path.join('.') || 'op'}: ${parsed.error.issues[0].message}.`);
    const op = parsed.data;
    switch (op.op) {
      case 'goal': {
        build.goal = { ...build.goal, ...op.set };
        const g = build.goal;
        say(`Goal: ${[g.style, g.propIn && `${g.propIn}"`, g.video, g.budgetUsd !== undefined && `$${g.budgetUsd} budget`, g.owns?.length && `has ${g.owns.join(', ')}`].filter(Boolean).join(', ')}`);
        break;
      }
      case 'add': {
        const part = PART_BY_ID.get(op.part);
        if (!part) {
          const near = searchParts(op.part.replace(/[._-]/g, ' '), { limit: 3 }).map(p => p.id);
          throw new BuildError(`There is no part "${op.part}" in the catalog.${near.length ? ` Did you mean ${near.join(', ')}?` : ''} For a part that is not listed, use {"op":"custom"}.`);
        }
        const old = place(build, { slot: part.category, category: part.category, part: part.id, qty: op.qty ?? part.qty ?? 1, note: op.note, by, at: now });
        say(`${old ? 'Swapped in' : 'Added'} ${part.brand} ${part.name}${old ? ` for ${label(resolve(old))}` : ''}`);
        break;
      }
      case 'custom': {
        const item: Item = { slot: op.category, category: op.category, qty: op.qty ?? 1, custom: { brand: op.brand, name: op.name, weightG: op.weightG, specs: op.specs, url: op.url }, note: op.note, by, at: now,
          price: op.priceUsd !== undefined ? { usd: op.priceUsd, store: op.store, url: op.url, at: now, by } : undefined };
        const old = place(build, item);
        say(`${old ? 'Swapped in' : 'Added'} ${op.brand ? `${op.brand} ` : ''}${op.name}${op.priceUsd !== undefined ? ` at $${op.priceUsd}` : ''}`);
        break;
      }
      case 'remove': { const item = findSlot(build, op.slot); build.items = build.items.filter(i => i !== item); say(`Removed ${label(resolve(item))}`); break; }
      case 'qty': { const item = findSlot(build, op.slot); item.qty = op.qty; say(`${label(resolve(item))}: quantity ${op.qty}`); break; }
      case 'price': { const item = findSlot(build, op.slot); item.price = { usd: op.usd, store: op.store, url: op.url, at: now, by }; say(`${label(resolve(item))}: $${op.usd}${op.store ? ` at ${op.store}` : ''}`); break; }
      case 'own': { const item = findSlot(build, op.slot); item.owned = op.owned || undefined; say(`${label(resolve(item))}: ${op.owned ? 'already owned' : 'to buy'}`); break; }
      case 'note': build.log.push({ at: now, by, kind: 'note', text: op.text }); break;
      case 'from': {
        const proven = PROVEN_BY_ID.get(op.build);
        if (!proven) throw new BuildError(`There is no proven build "${op.build}". Proven builds: ${PROVEN.map(p => p.id).join(', ')}.`);
        build.items = [];
        for (const id of proven.parts) { const part = PART_BY_ID.get(id)!; place(build, { slot: part.category, category: part.category, part: id, qty: part.qty ?? 1, by, at: now }); }
        build.goal = { ...build.goal, style: proven.style as Goal['style'], propIn: proven.propIn, video: proven.video };
        build.from = proven.id;
        say(`Started from the proven build “${proven.name}”`);
        break;
      }
    }
  });
  build.log = build.log.slice(-300);
  return build;
}

// ---- Checks and estimates ----------------------------------------------------------------------------------------

export type Level = 'fail' | 'warn' | 'todo' | 'info' | 'ok';
export interface Check { level: Level; text: string; slots: string[] }
export interface Analysis {
  costUsd: number; ownedUsd: number; unpricedSlots: string[]; gearUsd: number; budgetLeftUsd?: number;
  weightG?: number; dryWeightG?: number; thrustToWeight?: number; flightMinutes?: [number, number];
  checks: Check[]; complete: boolean;
}
/** Usable rpm per volt band by prop size: kv × cells × 4.2 V, in thousands of rpm. */
function rpmBand(propIn: number): [number, number] {
  if (propIn <= 2) return [70, 140];
  if (propIn <= 3) return [50, 85];
  if (propIn <= 4) return [45, 70];
  if (propIn <= 5.5) return [38, 52];
  if (propIn <= 6.5) return [32, 45];
  return [26, 40];
}
const statorFor = (propIn: number): [number, number] => propIn <= 2 ? [6, 11] : propIn <= 3 ? [12, 15] : propIn <= 4 ? [14, 20] : propIn <= 5.5 ? [22, 24] : propIn <= 6.5 ? [23, 27] : [27, 30];
/** Average power per gram of take-off weight in normal flying, by size. Rough on purpose. */
const wattsPerGram = (propIn: number, style?: string) => (propIn <= 2 ? 0.4 : propIn <= 3 ? 0.36 : propIn <= 4 ? 0.32 : propIn <= 5.5 ? 0.34 : 0.22) * (style === 'long-range' || style === 'cinematic' ? 0.8 : 1);
export const cellRange = (c: [number, number]) => c[0] === c[1] ? `${c[0]}S` : `${c[0]}–${c[1]}S`;
const VIDEO_NAME: Record<string, string> = { analog: 'analog', dji: 'DJI', walksnail: 'Walksnail', hdzero: 'HDZero' };

export function analyse(build: Build): Analysis {
  const checks: Check[] = [];
  const add = (level: Level, text: string, ...slots: string[]) => checks.push({ level, text, slots });
  const items = build.items.map(resolve);
  const at = (slot: string) => items.find(r => r.item.slot === slot);
  const frame = at('frame'), motors = at('motors'), stack = at('stack'), props = at('props'), battery = at('battery'), receiver = at('receiver'), vtx = at('vtx'), camera = at('camera'), gps = at('gps'), radio = at('radio'), goggles = at('goggles');
  const owns = new Set<string>(build.goal.owns ?? []);

  // Cost
  let costUsd = 0, ownedUsd = 0, gearUsd = 0;
  const unpricedSlots: string[] = [];
  for (const r of items) {
    if (r.unitUsd === undefined) { if (!r.item.owned) unpricedSlots.push(r.item.slot); continue; }
    const total = r.unitUsd * r.item.qty;
    if (r.item.owned) { ownedUsd += total; continue; }
    if (GEAR.has(r.item.category)) gearUsd += total;
    costUsd += total;
  }
  costUsd = Math.round(costUsd * 100) / 100;
  const budgetLeftUsd = build.goal.budgetUsd !== undefined ? Math.round((build.goal.budgetUsd - costUsd) * 100) / 100 : undefined;

  // What is missing
  const includes = (r: Resolved | undefined, what: 'camera' | 'antenna' | 'receiver') => !!r?.specs.includes?.includes(what);
  for (const s of SLOTS.filter(s => s.needed)) {
    if (at(s.id)) continue;
    if (s.id === 'camera' && includes(vtx, 'camera')) continue;
    if (s.id === 'receiver' && includes(stack, 'receiver')) continue;
    add('todo', `Choose ${s.id === 'vtx' ? 'a video transmitter' : s.id === 'stack' ? 'a flight controller and ESC' : s.id === 'props' ? 'props' : s.id === 'motors' ? 'motors' : `a ${s.label.toLowerCase()}`}.`, s.id);
  }
  if (camera && includes(vtx, 'camera')) add('info', `${label(vtx!)} comes with its own camera, so ${label(camera)} is not needed.`, 'camera', 'vtx');
  if (vtx && !includes(vtx, 'antenna') && !at('antenna')) add('todo', 'Add a 5.8 GHz video antenna: this transmitter comes without one.', 'antenna');
  if (build.goal.style === 'long-range' && !gps) add('warn', 'Long range without GPS: add one so GPS rescue can bring it home if the link drops.', 'gps');
  for (const g of ['radio', 'goggles', 'charger'] as const) if (!at(g) && !owns.has(g)) add('todo', `You also need ${g === 'radio' ? 'a radio' : g === 'goggles' ? 'goggles' : 'a charger'} to fly, unless you already have one.`, g);

  // Size
  const size = props?.specs.propIn ?? frame?.specs.propIn ?? build.goal.propIn;
  if (frame?.specs.propIn && props?.specs.propIn) {
    if (props.specs.propIn > frame.specs.propIn + 0.05) add('fail', `${props.specs.propIn}" props are too big for ${label(frame)}, which takes up to ${frame.specs.propIn}".`, 'props', 'frame');
    else if (props.specs.propIn < frame.specs.propIn - 1) add('warn', `${props.specs.propIn}" props on a frame made for ${frame.specs.propIn}": it will fly, but inefficiently.`, 'props', 'frame');
  }
  if (motors?.specs.stator && size) {
    const width = Number(motors.specs.stator.slice(0, 2)), [lo, hi] = statorFor(size);
    if (width < lo) add('warn', `${motors.specs.stator} motors are small for ${size}" props; they will run hot and feel soft.`, 'motors', 'props');
    else if (width > hi) add('warn', `${motors.specs.stator} motors are heavy for ${size}" props.`, 'motors', 'props');
  }
  // Mounts
  if (frame?.specs.mounts && stack?.specs.mounts && !stack.specs.mounts.some(m => frame.specs.mounts!.includes(m))) add('fail', `${label(stack)} is ${stack.specs.mounts[0]}${stack.specs.mounts[0] === 'whoop' ? '' : ' mm'}; ${label(frame)} takes ${frame.specs.mounts.join(' or ')}${frame.specs.mounts[0] === 'whoop' ? '' : ' mm'}.`, 'stack', 'frame');
  // Battery against motors and stack
  const cells = battery?.specs.series;
  if (cells && motors?.specs.cells && (cells < motors.specs.cells[0] || cells > motors.specs.cells[1])) add('fail', `${cells}S battery with motors rated ${cellRange(motors.specs.cells)}.`, 'battery', 'motors');
  if (cells && stack?.specs.cells && (cells < stack.specs.cells[0] || cells > stack.specs.cells[1])) add('fail', `${cells}S battery with a flight controller and ESC rated ${cellRange(stack.specs.cells)}.`, 'battery', 'stack');
  if (cells && motors?.specs.kv && size) {
    const k = motors.specs.kv * cells * 4.2 / 1000, [lo, hi] = rpmBand(size);
    if (k > hi * 1.12) add('warn', `${motors.specs.kv} KV on ${cells}S spins ${Math.round(k)}k rpm with no load: high for ${size}" props. Expect heat and short flights.`, 'motors', 'battery');
    else if (k < lo * 0.88) add('warn', `${motors.specs.kv} KV on ${cells}S is only ${Math.round(k)}k rpm: it will feel sluggish on ${size}" props.`, 'motors', 'battery');
  }
  if (motors?.specs.amps && stack?.specs.amps && stack.specs.amps < motors.specs.amps * 0.75) add('warn', `The ESC is rated ${stack.specs.amps} A; these motors can pull ${motors.specs.amps} A. Keep throttle punches short or choose a bigger ESC.`, 'stack', 'motors');
  if (battery?.specs.chem === 'Li-ion' && build.goal.style && build.goal.style !== 'long-range' && build.goal.style !== 'cinematic') add('warn', 'Li-ion packs sag under hard punches: fine for cruising, poor for freestyle.', 'battery');
  if (motors && motors.item.qty < 4) add('fail', `A quad needs 4 motors; the build has ${motors.item.qty}.`, 'motors');
  // Video system
  const system = vtx?.specs.video;
  if (system && camera?.specs.video && !includes(vtx, 'camera') && camera.specs.video !== system) add('fail', `${label(camera)} is an ${VIDEO_NAME[camera.specs.video]} camera; ${label(vtx!)} is ${VIDEO_NAME[system]}.`, 'camera', 'vtx');
  if (system && goggles?.specs.video && goggles.specs.video !== system) add('fail', `${label(goggles)} cannot show ${VIDEO_NAME[system]} video from ${label(vtx!)}.`, 'goggles', 'vtx');
  if (system && build.goal.video && build.goal.video !== system) add('warn', `The goal says ${VIDEO_NAME[build.goal.video]} video, but the transmitter is ${VIDEO_NAME[system]}.`, 'vtx');
  // Control link
  const rxLink = receiver?.specs.link ?? (includes(stack, 'receiver') ? stack!.specs.link : undefined);
  if (rxLink && radio?.specs.link && radio.specs.link !== rxLink) add('fail', `${label(radio)} speaks ${radio.specs.link}; the receiver is ${rxLink}.`, 'radio', receiver ? 'receiver' : 'stack');
  if (rxLink && !radio && owns.has('radio')) add('info', `Make sure your radio speaks ${rxLink}, or has a module for it.`, receiver ? 'receiver' : 'stack');

  // Weight and performance
  const flying = items.filter(r => !GEAR.has(r.item.category) && !(r.item.category === 'camera' && includes(vtx, 'camera')));
  let dry = 0, known = true;
  for (const r of flying) {
    if (r.item.category === 'battery') continue;
    if (r.weightG === undefined) { if (r.item.category !== 'other') known = false; continue; }
    dry += r.weightG * (r.item.category === 'motors' ? Math.min(r.item.qty, 4) : r.item.category === 'props' ? 1 : r.item.qty);
  }
  const needsForWeight = ['frame', 'motors', 'stack', 'props'].every(s => at(s));
  const dryWeightG = needsForWeight && known ? Math.round(dry) : undefined;
  const weightG = dryWeightG !== undefined && battery?.weightG ? Math.round(dry + battery.weightG) : undefined;
  const thrustToWeight = weightG && motors?.specs.thrustG ? Math.round(motors.specs.thrustG * 4 / weightG * 10) / 10 : undefined;
  if (thrustToWeight !== undefined) {
    const want = build.goal.style === 'freestyle' || build.goal.style === 'racing' ? 6 : build.goal.style === 'long-range' ? 3 : 3.5;
    if (thrustToWeight < 2) add('fail', `About ${thrustToWeight}:1 thrust to weight: it would barely lift off.`, 'motors', 'battery');
    else if (thrustToWeight < want) add('warn', `About ${thrustToWeight}:1 thrust to weight; ${build.goal.style ?? 'this kind of flying'} wants ${want}:1 or more.`, 'motors', 'battery');
    else add('ok', `About ${thrustToWeight}:1 thrust to weight.`, 'motors');
  }
  let flightMinutes: [number, number] | undefined;
  if (weightG && battery?.specs.mah && cells && size) {
    const volts = battery.specs.chem === 'Li-ion' ? 3.6 : 3.75, wh = battery.specs.mah / 1000 * cells * volts * 0.8;
    const minutes = wh / (weightG * wattsPerGram(size, build.goal.style)) * 60;
    flightMinutes = [Math.max(1, Math.round(minutes * 0.75)), Math.max(1, Math.round(minutes * 1.2))];
  }
  if (weightG !== undefined && weightG >= 250) add('info', `About ${weightG} g with the battery: at 250 g and over, most countries require registration, and the US requires Remote ID.`, 'battery');
  if (weightG !== undefined && weightG < 250) add('ok', `About ${weightG} g with the battery: under the 250 g line.`, 'battery');
  if (budgetLeftUsd !== undefined && budgetLeftUsd < 0) add('warn', `$${Math.abs(Math.round(budgetLeftUsd))} over the $${build.goal.budgetUsd} budget.`);
  if (unpricedSlots.length) add('info', `No price yet for ${unpricedSlots.join(', ')}.`, ...unpricedSlots);

  const rank: Record<Level, number> = { fail: 0, warn: 1, todo: 2, info: 3, ok: 4 };
  checks.sort((a, b) => rank[a.level] - rank[b.level]);
  const complete = !checks.some(c => c.level === 'fail' || (c.level === 'todo' && !c.slots.some(s => GEAR.has(s))));
  return { costUsd, ownedUsd, unpricedSlots, gearUsd, budgetLeftUsd, weightG, dryWeightG, thrustToWeight, flightMinutes, checks, complete };
}

// ---- Finding parts -----------------------------------------------------------------------------------------------

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
const haystack = (p: Part) => `${p.id} ${p.category} ${SLOT_LABEL[p.category]} ${p.brand} ${p.name} ${p.blurb} ${p.specs.video ?? ''} ${p.specs.link ?? ''} ${p.specs.series ? `${p.specs.series}s` : ''} ${p.specs.propIn ? `${p.specs.propIn}" ${p.specs.propIn}in ${Math.round(p.specs.propIn)}inch` : ''} ${p.specs.stator ?? ''} ${p.specs.kv ? `${p.specs.kv}kv` : ''}`.toLowerCase();
/** Search the catalog. Every word must match somewhere; category names and synonyms count. */
export function searchParts(query: string, options: { category?: string; limit?: number } = {}): Part[] {
  const syn: Record<string, string> = { esc: 'stack', fc: 'stack', 'flight': 'stack', controller: 'stack', aio: 'stack', motor: 'motors', prop: 'props', propeller: 'props', propellers: 'props', lipo: 'battery', batteries: 'battery', pack: 'battery', rx: 'receiver', elrs: 'elrs', vtx: 'vtx', video: 'vtx', 'air': 'vtx', cam: 'camera', antennas: 'antenna', goggle: 'goggles', transmitter: 'radio', controller_: 'radio', charger: 'charger', digital: 'dji' };
  const list = words(query).map(w => syn[w] ?? w).filter(w => !['a', 'the', 'for', 'and', 'with', 'part', 'parts', 'cheap', 'budget', 'best', 'good'].includes(w));
  const cheap = /cheap|budget|low cost/.test(query.toLowerCase());
  // A bare number is a size: "5" finds 5" parts, not every part with a 5 in its name.
  const has = (p: Part, w: string) => /^\d+(\.\d+)?$/.test(w) ? haystack(p).split(/[\s/]+/).some(t => t.replace(/("|in|inch)$/, '') === w) : haystack(p).includes(w);
  const inCategory = (p: Part) => !options.category || p.category === options.category;
  let out = PARTS.filter(p => inCategory(p) && list.every(w => has(p, w)));
  if (!out.length && list.length > 1) out = PARTS.filter(p => inCategory(p) && list.some(w => has(p, w)));
  if (cheap) out = [...out].sort((a, b) => a.priceUsd - b.priceUsd);
  return out.slice(0, options.limit ?? 12);
}
export function searchProven(query: string) {
  const list = words(query).filter(w => !['build', 'builds', 'a', 'the', 'drone', 'quad'].includes(w));
  return PROVEN.filter(p => !list.length || list.some(w => `${p.id} ${p.name} ${p.style} ${p.summary} ${p.video}`.toLowerCase().includes(w)));
}

/** How a catalog part would sit in this build: its new problems, and the change in cost and weight. */
export interface Fit { part: Part; fit: 'fits' | 'warn' | 'fails'; problems: string[]; costDeltaUsd: number; weightDeltaG?: number }
export function fitOf(build: Build, part: Part): Fit {
  const before = analyse(build), current = build.items.find(i => i.slot === part.category);
  const after = analyse(applyBuildOps(build, [{ op: 'add', part: part.id }], '·', 0));
  const was = new Set(before.checks.map(c => c.text));
  const problems = after.checks.filter(c => (c.level === 'fail' || c.level === 'warn') && !was.has(c.text) && (c.slots.includes(part.category) || !c.slots.length)).map(c => c.text);
  const fails = after.checks.some(c => c.level === 'fail' && c.slots.includes(part.category));
  const currentWeight = current ? resolve(current).weightG : 0;
  return { part, fit: fails ? 'fails' : problems.length ? 'warn' : 'fits', problems, costDeltaUsd: Math.round((after.costUsd - before.costUsd) * 100) / 100,
    weightDeltaG: part.weightG !== undefined && currentWeight !== undefined ? Math.round((part.weightG - currentWeight) * (part.category === 'motors' ? 4 : 1)) : undefined };
}
/** Comparable parts for a slot, best fit first, then cheapest. */
export function alternatives(build: Build, category: string, limit = 6): Fit[] {
  const current = build.items.find(i => i.slot === category)?.part;
  const order = { fits: 0, warn: 1, fails: 2 };
  return PARTS.filter(p => p.category === category && p.id !== current).map(p => fitOf(build, p)).sort((a, b) => order[a.fit] - order[b.fit] || a.part.priceUsd - b.part.priceUsd).slice(0, limit);
}

// ---- Summaries and comparison ------------------------------------------------------------------------------------

export function provenBuild(id: string): Build { return applyBuildOps(emptyBuild(), [{ op: 'from', build: id }], 'Lucidity', 0); }

/** What an assistant needs to talk about a build, kept small. */
export function buildSummary(build: Build) {
  const a = analyse(build);
  return {
    goal: build.goal,
    parts: build.items.map(i => { const r = resolve(i); return { slot: i.slot, part: i.part, name: label(r), qty: i.qty, unitUsd: r.unitUsd, price: r.priceSource, ...(i.price?.store ? { seenAt: i.price.store } : {}), ...(i.owned ? { owned: true } : {}) }; }),
    costUsd: a.costUsd, budgetLeftUsd: a.budgetLeftUsd, weightG: a.weightG, thrustToWeight: a.thrustToWeight, flightMinutes: a.flightMinutes, complete: a.complete,
    checks: a.checks.filter(c => c.level !== 'ok').map(c => `${c.level}: ${c.text}`).slice(0, 12),
  };
}

export interface Comparison { names: string[]; rows: { label: string; values: (string | null)[]; best?: number }[] }
export function compareBuilds(list: { name: string; build: Build }[]): Comparison {
  const analyses = list.map(b => analyse(b.build));
  const money = (n: number) => `$${Math.round(n)}`;
  const pick = (values: (number | undefined)[], better: 'low' | 'high') => { const known = values.map((v, i) => [v, i] as const).filter(([v]) => v !== undefined) as [number, number][]; if (known.length < 2) return undefined; known.sort((x, y) => better === 'low' ? x[0] - y[0] : y[0] - x[0]); return known[0][0] === known[1][0] ? undefined : known[0][1]; };
  const rows: Comparison['rows'] = [
    { label: 'Cost', values: analyses.map(a => money(a.costUsd)), best: pick(analyses.map(a => a.costUsd), 'low') },
    { label: 'Weight', values: analyses.map(a => a.weightG ? `${a.weightG} g` : null), best: pick(analyses.map(a => a.weightG), 'low') },
    { label: 'Thrust to weight', values: analyses.map(a => a.thrustToWeight ? `${a.thrustToWeight}:1` : null), best: pick(analyses.map(a => a.thrustToWeight), 'high') },
    { label: 'Flight time', values: analyses.map(a => a.flightMinutes ? `${a.flightMinutes[0]}–${a.flightMinutes[1]} min` : null), best: pick(analyses.map(a => a.flightMinutes?.[1]), 'high') },
    { label: 'Problems', values: analyses.map(a => { const f = a.checks.filter(c => c.level === 'fail').length, w = a.checks.filter(c => c.level === 'warn').length; return f || w ? [f && `${f} blocking`, w && `${w} to watch`].filter(Boolean).join(', ') : 'None'; }) },
  ];
  for (const s of SLOTS) {
    const values = list.map(b => { const i = b.build.items.find(x => x.slot === s.id); if (!i) return null; const r = resolve(i); return `${label(r)}${r.unitUsd !== undefined ? ` · ${money(r.unitUsd * i.qty)}` : ''}`; });
    if (values.some(Boolean)) rows.push({ label: s.label, values });
  }
  return { names: list.map(b => b.name), rows };
}
