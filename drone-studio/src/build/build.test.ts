import { describe, expect, it } from 'vitest';
import { alternatives, analyse, applyBuildOps, BuildError, buildSchema, compareBuilds, emptyBuild, fitOf, provenBuild, searchParts, searchProven, type Build } from './build';
import { PART_BY_ID, PARTS, PROVEN, storeLinks } from './catalog';

const build = (...ops: unknown[]) => applyBuildOps(emptyBuild(), ops, 'Claude', 1000);
const texts = (b: Build, level?: string) => analyse(b).checks.filter(c => !level || c.level === level).map(c => c.text);

describe('the catalog', () => {
  it('has unique ids, sane prices, and a search link at every store for every part', () => {
    expect(new Set(PARTS.map(p => p.id)).size).toBe(PARTS.length);
    for (const p of PARTS) {
      expect(p.priceUsd).toBeGreaterThan(0);
      expect(storeLinks(p).every(l => l.url.startsWith('https://'))).toBe(true);
      if (p.maker) expect(p.maker).toMatch(/^https:\/\//);
    }
  });
  it('builds every proven build from catalog parts, with nothing that would not work', () => {
    for (const p of PROVEN) {
      for (const id of p.parts) expect(PART_BY_ID.has(id), id).toBe(true);
      const b = provenBuild(p.id), a = analyse(b);
      expect(texts(b, 'fail'), p.id).toEqual([]);
      expect(texts(b, 'warn'), p.id).toEqual([]);
      expect(a.complete, p.id).toBe(true);
      expect(a.weightG).toBeGreaterThan(0);
      expect(buildSchema.safeParse(b).success).toBe(true);
    }
  });
  it('keeps the sub-250 g build under 250 g', () => {
    expect(analyse(provenBuild('proven.25-sub250')).weightG).toBeLessThan(250);
  });
});

describe('editing a build', () => {
  it('puts one part in each slot, swaps on a second add, and logs who did what', () => {
    const b = build({ op: 'add', part: 'motor.eco2-2207-1900' }, { op: 'add', part: 'motor.velox-v2207-1950' }, { op: 'note', text: 'Velox for smoother footage.' });
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ slot: 'motors', part: 'motor.velox-v2207-1950', qty: 4, by: 'Claude' });
    expect(b.log.map(l => l.text)).toEqual(['Added Emax ECO II 2207 1900KV', 'Swapped in T-Motor Velox V2207.5 V2 1950KV for Emax ECO II 2207 1900KV', 'Velox for smoother footage.']);
  });
  it('is all or nothing, and names the near miss', () => {
    const before = build({ op: 'add', part: 'frame.apex-5' });
    expect(() => applyBuildOps(before, [{ op: 'remove', slot: 'frame' }, { op: 'add', part: 'motor.velox' }], 'Claude')).toThrow(/Did you mean motor\.velox-v2207-1950/);
    expect(() => applyBuildOps(before, [{ op: 'qty', slot: 'gps', qty: 2 }], 'Claude')).toThrow(BuildError);
    expect(() => applyBuildOps(before, [{ op: 'price', slot: 'frame', usd: 90, url: 'javascript:alert(1)' }], 'Claude')).toThrow(/https/);
    expect(before.items).toHaveLength(1);
  });
  it('records a price someone looked up, and uses it instead of the typical one', () => {
    const b = build({ op: 'add', part: 'frame.apex-5' }, { op: 'price', slot: 'frame', usd: 89.99, store: 'RaceDayQuads', url: 'https://www.racedayquads.com/products/apex' });
    expect(analyse(b).costUsd).toBe(89.99);
    expect(b.items[0].price).toMatchObject({ usd: 89.99, store: 'RaceDayQuads', by: 'Claude' });
  });
  it('leaves owned parts out of the cost, and takes parts that are not in the catalog', () => {
    const b = build({ op: 'add', part: 'radio.pocket-elrs' }, { op: 'own', slot: 'radio', owned: true }, { op: 'custom', category: 'other', name: 'XT60 pigtails', priceUsd: 6 }, { op: 'custom', category: 'other', name: 'Battery straps', priceUsd: 5 });
    expect(b.items.map(i => i.slot)).toEqual(['radio', 'other.1', 'other.2']);
    expect(analyse(b)).toMatchObject({ costUsd: 11, ownedUsd: 70 });
  });
  it('starts from a proven build and keeps the goal', () => {
    const b = build({ op: 'goal', set: { budgetUsd: 450 } }, { op: 'from', build: 'proven.5in-analog-starter' });
    expect(b.goal).toMatchObject({ budgetUsd: 450, style: 'freestyle', propIn: 5, video: 'analog' });
    expect(b.from).toBe('proven.5in-analog-starter');
    expect(analyse(b).budgetLeftUsd).toBe(450 - analyse(b).costUsd);
  });
});

describe('checking a build', () => {
  it('lists what is still missing, and what else you need to fly', () => {
    const t = texts(build({ op: 'add', part: 'frame.source-one-v5' }), 'todo');
    expect(t).toEqual(expect.arrayContaining(['Choose motors.', 'Choose a flight controller and ESC.', 'Choose a battery.', expect.stringMatching(/need a radio/)]));
    expect(texts(build({ op: 'goal', set: { owns: ['radio'] } }), 'todo').some(t => /radio/.test(t))).toBe(false);
  });
  it('catches parts that do not go together', () => {
    const b = build({ op: 'add', part: 'frame.cinelog35-v2' }, { op: 'add', part: 'stack.speedybee-f405-v4' }, { op: 'add', part: 'props.ethix-s5' }, { op: 'add', part: 'motor.speedx2-1505-3600' },
      { op: 'add', part: 'battery.rline-6s-1300' }, { op: 'add', part: 'vtx.rush-tank-ultimate' }, { op: 'add', part: 'goggles.dji-n3' }, { op: 'add', part: 'rx.crossfire-nano' }, { op: 'add', part: 'radio.pocket-elrs' });
    const fails = texts(b, 'fail').join('\n');
    expect(fails).toMatch(/5" props are too big for GEPRC CineLog35 V2 frame/);
    expect(fails).toMatch(/30\.5 mm; GEPRC CineLog35 V2 frame takes 20 or 25\.5 mm/);
    expect(fails).toMatch(/6S battery with motors rated 3–4S/);
    expect(fails).toMatch(/cannot show analog video/);
    expect(fails).toMatch(/speaks ELRS 2\.4; the receiver is Crossfire/);
    expect(analyse(b).complete).toBe(false);
  });
  it('warns about a motor that will spin too fast, and long range without GPS', () => {
    const b = build({ op: 'goal', set: { style: 'long-range' } }, { op: 'add', part: 'motor.eco2-2207-2400' }, { op: 'add', part: 'props.ethix-s5' }, { op: 'add', part: 'battery.cnhl-6s-1100' });
    const warn = texts(b).join('\n');
    expect(warn).toMatch(/2400 KV on 6S/);
    expect(warn).toMatch(/Long range without GPS/);
  });
  it('knows a digital air unit brings its own camera and antenna', () => {
    const t = texts(build({ op: 'add', part: 'vtx.dji-o4-pro' })).join('\n');
    expect(t).not.toMatch(/camera|antenna/i);
    expect(texts(build({ op: 'add', part: 'vtx.rush-tank-ultimate' })).join('\n')).toMatch(/Choose a camera[\s\S]*video antenna/);
  });
});

describe('finding and comparing', () => {
  it('searches by words, categories and synonyms', () => {
    expect(searchParts('6s lipo').every(p => p.category === 'battery' && p.specs.series === 6)).toBe(true);
    expect(searchParts('dji goggles').map(p => p.id)).toEqual(['goggles.dji-n3', 'goggles.dji-3']);
    expect(searchParts('cheap 5 motor')[0].id).toBe('motor.eco2-2207-1900');
    expect(searchProven('long range').map(p => p.id)).toContain('proven.7in-long-range');
  });
  it('ranks comparable parts by fit for this build, then by price', () => {
    const alts = alternatives(provenBuild('proven.5in-analog-starter'), 'stack');
    expect(alts.map(a => [a.part.id, a.fit])).toEqual([['stack.speedybee-f405-mini', 'fits'], ['stack.tmotor-f7-pacer-55', 'fits'], ['stack.betafpv-f4-1s-aio', 'fails']]);
    expect(alternatives(provenBuild('proven.35-cinewhoop'), 'stack').find(a => a.part.id === 'stack.speedybee-f405-v4')).toMatchObject({ fit: 'fails' });
    expect(fitOf(provenBuild('proven.35-cinewhoop'), PART_BY_ID.get('battery.rline-6s-1300')!)).toMatchObject({ fit: 'fails', costDeltaUsd: 60 });
  });
  it('compares builds side by side and marks the best value', () => {
    const c = compareBuilds([{ name: 'Starter', build: provenBuild('proven.5in-analog-starter') }, { name: 'DJI', build: provenBuild('proven.5in-dji-freestyle') }]);
    expect(c.names).toEqual(['Starter', 'DJI']);
    expect(c.rows.find(r => r.label === 'Cost')).toMatchObject({ best: 0 });
    expect(c.rows.find(r => r.label === 'Video transmitter')!.values[1]).toMatch(/O4 Air Unit Pro/);
  });
});

describe('extras', () => {
  it('groups parts into essentials, extras and gear, and only weighs extras that fly', async () => {
    const { groupOf } = await import('./build');
    expect(['frame', 'antenna', 'gps', 'other', 'radio'].map(groupOf)).toEqual(['essential', 'essential', 'extra', 'extra', 'gear']);
    const base = provenBuild('proven.5in-analog-starter'), before = analyse(base).weightG!;
    const b = applyBuildOps(base, [{ op: 'add', part: 'extra.pinecil' }, { op: 'add', part: 'extra.vifly-finder-mini' }], 'you');
    expect(b.items.filter(i => i.category === 'other').map(i => i.slot)).toEqual(['other.1', 'other.2']);
    expect(analyse(b).weightG).toBe(before + 4);
    expect(analyse(b).costUsd).toBe(analyse(base).costUsd + 41);
  });
});
