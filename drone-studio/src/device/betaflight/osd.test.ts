import { afterEach, describe, expect, it } from 'vitest';
import { loopback } from '../transport';
import { BetaflightSim } from '../sim/betaflight';
import { BetaflightDriver } from './driver';
import { decodeOsd, encodeOsd, osdLayout, parseOsdValue } from './osd';

describe('OSD positions', () => {
  it('match Betaflight osd.h, including the HD x bit, profiles and style', () => {
    // OSD_POS(x, y) | OSD_PROFILE_1_FLAG for x = 1, y = 14: 1 | (14 << 5) | 0x800.
    expect(decodeOsd(0x800 | (14 << 5) | 1)).toEqual({ x: 1, y: 14, profiles: 1, type: 0 });
    expect(decodeOsd(0x400 | (5 << 5) | 3)).toMatchObject({ x: 35, y: 5, profiles: 0 });
    expect(encodeOsd({ x: 50, y: 18, profiles: 1, type: 2 })).toBe((50 & 31) | 0x400 | (18 << 5) | 0x800 | (2 << 14));
    for (let v = 0; v < 65536; v += 97) expect(encodeOsd(decodeOsd(v))).toBe(v);
  });
  it('take "x,y,on" and keep the style and other profiles', () => {
    const current = encodeOsd({ x: 1, y: 1, profiles: 0b110, type: 1 });
    expect(decodeOsd(parseOsdValue('10,12,on', current))).toEqual({ x: 10, y: 12, profiles: 0b111, type: 1 });
    expect(decodeOsd(parseOsdValue('10, 12', current))).toEqual({ x: 10, y: 12, profiles: 0b110, type: 1 });
    expect(parseOsdValue(2081, 0)).toBe(2081);
    expect(() => parseOsdValue('top left', 0)).toThrow(expect.objectContaining({ hint: expect.stringContaining('x,y') }));
    expect(() => parseOsdValue('70,1', 0)).toThrow(/0 to 63/);
  });
});

describe('OSD layout on a simulated Betaflight flight controller', () => {
  const timing = { mspMs: 300, cliMs: 2000, cliIdleMs: 15, pollMs: 15, rebootMs: 60 };
  const open: BetaflightDriver[] = [];
  afterEach(async () => { for (const d of open.splice(0)) await d.close(); });
  async function plug(sim: BetaflightSim) { const [host, device] = loopback(); sim.attach(device); const d = await BetaflightDriver.connect(host, { timing }); open.push(d); return d; }

  it('reads the screen, moves two elements and hides one in a single save', async () => {
    const sim = new BetaflightSim();
    const driver = await plug(sim);
    await driver.loadSettings();
    const layout = osdLayout(driver.settings())!;
    expect(layout).toMatchObject({ columns: 30, rows: 16, system: 'PAL' });
    expect(layout.elements.find(e => e.key === 'vbat')).toMatchObject({ name: 'Battery voltage', pos: { x: 1, y: 14 }, visible: true });
    expect(layout.elements.find(e => e.key === 'current')).toMatchObject({ visible: false });
    expect(driver.settings().find(s => s.id === 'bf.osd_vbat_pos')).toMatchObject({ part: 'osd', title: 'Battery voltage position' });
    const results = await driver.write([
      { id: 'bf.osd_vbat_pos', value: '2,13,on' }, { id: 'bf.osd_rssi_pos', value: '24,1' }, { id: 'bf.osd_crosshairs_pos', value: '13,6,off' },
    ], { grant: { operation: 'write', conditions: [] } });
    expect(results.every(r => r.ok)).toBe(true);
    expect(sim.reboots).toBe(1);
    const again = await plug(sim);
    await again.loadSettings();
    const after = osdLayout(again.settings())!;
    expect(after.elements.find(e => e.key === 'vbat')!.pos).toMatchObject({ x: 2, y: 13 });
    expect(after.elements.find(e => e.key === 'rssi')).toMatchObject({ pos: { x: 24, y: 1 }, visible: true });
    expect(after.elements.find(e => e.key === 'crosshairs')!.visible).toBe(false);
  });
  it('sizes the canvas for HD video systems', async () => {
    const sim = new BetaflightSim();
    sim.settings.vcd_video_system.value = 'HD'; sim.settings.osd_canvas_width.value = '53'; sim.settings.osd_canvas_height.value = '20';
    const driver = await plug(sim);
    await driver.loadSettings();
    expect(osdLayout(driver.settings())).toMatchObject({ columns: 53, rows: 20, system: 'HD' });
  });
});
