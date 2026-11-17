import { afterEach, describe, expect, it } from 'vitest';
import { loopback } from '../transport';
import { BetaflightSim } from '../sim/betaflight';
import type { Grant } from '../types';
import { BetaflightDriver } from './driver';
import { frequency, parseVtxTable, presetName, validateVtxTable, vtxTableCommands, VTX_PRESETS } from './vtx';

const timing = { mspMs: 300, cliMs: 2000, cliIdleMs: 15, pollMs: 15, rebootMs: 60 };
const grant: Grant = { operation: 'write', conditions: [] };
const open: BetaflightDriver[] = [];
afterEach(async () => { for (const d of open.splice(0)) await d.close(); });
async function plug(sim: BetaflightSim) { const [host, device] = loopback(); sim.attach(device); const d = await BetaflightDriver.connect(host, { timing }); open.push(d); return d; }

describe('video tables', () => {
  it('round-trip through console commands', () => {
    const t = VTX_PRESETS['SmartAudio 2.1'];
    expect(parseVtxTable(vtxTableCommands(t).join('\n'))).toEqual(t);
    expect(presetName(t)).toBe('SmartAudio 2.1');
    expect(presetName({ ...t, channels: 8, powers: [{ value: 1, label: 'X' }] })).toBe('custom');
    expect(frequency(t, 5, 8)).toBe(5917);
    expect(frequency(t, 3, 4)).toBeUndefined();
  });
  it('refuse tables that would confuse the flight controller', () => {
    const t = structuredClone(VTX_PRESETS.Tramp);
    expect(() => validateVtxTable({ ...t, channels: 9 })).toThrow(/1 to 8 channels/);
    expect(() => validateVtxTable({ ...t, bands: [{ ...t.bands[0], frequencies: [5865] }] })).toThrow(/needs 8 frequencies/);
    expect(() => validateVtxTable({ ...t, bands: [{ ...t.bands[0], name: 'bad name;save' }] })).toThrow(/band names/);
    expect(() => validateVtxTable({ ...t, powers: [{ value: 25, label: '25mW!' }] })).toThrow(/labels/);
  });
});

describe('video tables on a simulated Betaflight flight controller', () => {
  it('start empty, take a preset, survive the save and restart, and name band, channel and power', async () => {
    const sim = new BetaflightSim();
    const driver = await plug(sim);
    await driver.loadSettings();
    expect(driver.settings().find(s => s.id === 'bf.vtxtable')).toMatchObject({ value: 'none', part: 'vtx' });
    const [result] = await driver.write([{ id: 'bf.vtxtable', value: 'Tramp', expected: 'none' }], { grant });
    expect(result).toMatchObject({ ok: true, before: 'none', after: 'Tramp' });
    expect(sim.reboots).toBe(1);
    const again = await plug(sim);
    await again.loadSettings();
    const all = again.settings();
    expect(all.find(s => s.id === 'bf.vtxtable')!.value).toBe('Tramp');
    expect(all.find(s => s.id === 'bf.vtx_band')!.options!.find(o => o.value === 5)!.label).toBe('R · raceband');
    expect(all.find(s => s.id === 'bf.vtx_channel')!.options!.find(o => o.value === 8)!.label).toBe('8 · 5917 MHz');
    expect(all.find(s => s.id === 'bf.vtx_power')!.options!.map(o => o.label)).toEqual(['25 mW', '100 mW', '200 mW', '400 mW', '600 mW']);
    expect(again.videoFrequency()).toBe(5917);
  });
  it('take a custom table as JSON, and refuse a bad one without writing anything', async () => {
    const sim = new BetaflightSim();
    const driver = await plug(sim);
    await driver.loadSettings();
    const bad = await driver.write([{ id: 'bf.vtxtable', value: JSON.stringify({ bands: [], channels: 8, powers: [] }) }], { grant });
    expect(bad[0]).toMatchObject({ ok: false, note: expect.stringContaining('1 to 8 bands') });
    expect(sim.reboots).toBe(0);
    const custom = { ...VTX_PRESETS['SmartAudio 2.0'], powers: [{ value: 0, label: '25' }, { value: 1, label: '400' }] };
    const [good] = await driver.write([{ id: 'bf.vtxtable', value: JSON.stringify(custom) }], { grant });
    expect(good).toMatchObject({ ok: true, after: 'custom' });
    const again = await plug(sim);
    await again.loadSettings();
    expect(again.settings().find(s => s.id === 'bf.vtx_power')!.options!.map(o => o.label)).toEqual(['25 mW', '400 mW']);
  });
});
