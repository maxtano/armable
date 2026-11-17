import { afterEach, describe, expect, it } from 'vitest';
import { BetaflightDriver } from '../betaflight/driver';
import { BetaflightSim } from '../sim/betaflight';
import { loopback } from '../transport';
import { analyzeBlackbox } from './analyze';
import { decodeAll, decodeLog, findLogs, isBlackbox } from './decode';
import { BitWriter, syntheticBlackbox, writeTag2_3S32, writeTag8_4S16v2 } from './encode';

/** A one-frame log whose single P frame is given as raw bytes, to test decoding against the reference rules. */
function oneField(encodingP: number, pBytes: number[], fields = 3, predictorP = 0) {
  const names = Array.from({ length: fields }, (_, i) => `f${i}`).join(',');
  const zeros = Array(fields).fill(0).join(','), ones = Array(fields).fill(1).join(',');
  const head = [`H Product:Blackbox flight data recorder by Nicholas Sherlock`, 'H Data version:2', 'H I interval:1', 'H P interval:1/1',
    `H Field I name:${names}`, `H Field I signed:${ones}`, `H Field I predictor:${zeros}`, `H Field I encoding:${zeros}`,
    `H Field P predictor:${Array(fields).fill(predictorP).join(',')}`, `H Field P encoding:${Array(fields).fill(encodingP).join(',')}`].join('\n') + '\n';
  const bytes = [...new TextEncoder().encode(head), 0x49, ...Array(fields).fill(0), 0x50, ...pBytes, 0x45, 255, ...new TextEncoder().encode('End of log\0')];
  const log = decodeAll(Uint8Array.from(bytes))[0];
  return log.frames[1];
}

describe('blackbox decoding against the reference encodings', () => {
  it('reads TAG2_3S32 in each of its four layouts', () => {
    expect(oneField(7, [0b00_01_11_10])).toEqual([1, -1, -2]);
    expect(oneField(7, [0b01_00_0111, 0b1000_0011])).toEqual([7, -8, 3]);
    expect(oneField(7, [0b10_100000, 0b00_011111, 0b00_000001])).toEqual([-32, 31, 1]);
    // Selector 3: field sizes 8, 16 and 32 bits, little-endian.
    expect(oneField(7, [0b11_11_01_00, 0x80, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12])).toEqual([-128, 0x1234, 0x12345678]);
  });
  it('reads TAG8_4S16 version 2 with its nibble packing, high nibble first and 16-bit big-endian', () => {
    // Fields: 4-bit, 8-bit (straddling), zero, 16-bit (straddling).
    const v = [-3, 100, 0, -1234];
    const w = new BitWriter(); writeTag8_4S16v2(w, v);
    expect(oneField(8, w.bytes, 4)).toEqual(v);
    // Hand-built: selector 4-bit,4-bit,8-bit,16-bit = 01 01 10 11 -> 0b11_10_01_01. Nibbles 0x7 and 0xF (=-1), then 0x80, then 0x1234.
    expect(oneField(8, [0b11100101, 0x7f, 0x80, 0x12, 0x34], 4)).toEqual([7, -1, -128, 0x1234]);
  });
  it('reads TAG8_8SVB groups and single values, and NEG_14BIT', () => {
    expect(oneField(6, [0b101, 0x02, 0x03], 3)).toEqual([1, 0, -2]);
    expect(oneField(6, [0x05], 1)).toEqual([-3]);
    expect(oneField(3, [0x7f, 0x01, 0x7f], 3)).toEqual([-127, -1, -127]);
  });
  it('applies the previous-value predictor to P frames', () => {
    const w = new BitWriter(); writeTag2_3S32(w, [5, -5, 1]);
    expect(oneField(7, w.bytes, 3, 1)).toEqual([5, -5, 1]);
  });
});

describe('blackbox round trip', () => {
  it('decodes every value the writer encoded, across I and P frames, slow frames and events', () => {
    const frames: number[][] = [];
    const bytes = syntheticBlackbox(2, 1, 250, frames);
    expect(isBlackbox(bytes)).toBe(true);
    const [log] = decodeAll(bytes);
    expect(log.frames).toHaveLength(frames.length);
    expect(log.frames).toEqual(frames);
    expect(log.stats).toMatchObject({ iFrames: 16, pFrames: 484, corrupt: 0 });
    expect(log.slow.frames.length).toBe(2);
    expect(log.events.map(e => e.name)).toEqual(['disarm', 'log end']);
    expect(log).toMatchObject({ firmware: expect.stringContaining('Betaflight 4.5.1'), craftName: 'DEMO5' });
  });
  it('finds every flight in a flash dump', () => {
    const dump = Uint8Array.from([...syntheticBlackbox(1, 1), ...syntheticBlackbox(1, 0.2), 0xff, 0xff, 0xff]);
    expect(findLogs(dump)).toHaveLength(2);
    expect(decodeAll(dump).map(l => l.index)).toEqual([1, 2]);
  });
  it('skips damaged frames and keeps going', () => {
    const frames: number[][] = [];
    const bytes = syntheticBlackbox(2, 1, 250, frames);
    const damaged = Uint8Array.from(bytes);
    const start = damaged.length >> 1;
    for (let i = start; i < start + 40; i++) damaged[i] = 0xff;
    const [log] = decodeAll(damaged);
    expect(log.stats.corrupt).toBeGreaterThan(0);
    expect(log.frames.length).toBeGreaterThan(frames.length * 0.8);
    // Frames after the next I frame are exact again.
    expect(log.frames.at(-1)).toEqual(frames.at(-1));
  });
  it('refuses something that is not a blackbox log', () => {
    expect(isBlackbox(new TextEncoder().encode('hello'))).toBe(false);
    expect(decodeAll(new Uint8Array(100))).toEqual([]);
    expect(() => decodeLog(new TextEncoder().encode('H Product:Blackbox flight data recorder by Nicholas Sherlock\n'), 0, 60)).toThrow(/no frame definitions/);
  });
});

describe('blackbox analysis', () => {
  it('tells a rough flight from a smooth one, in the same shape as ArduPilot logs', () => {
    const rough = analyzeBlackbox(decodeAll(syntheticBlackbox(4, 1))[0]);
    const smooth = analyzeBlackbox(decodeAll(syntheticBlackbox(4, 0.1))[0]);
    expect(rough.format).toBe('Betaflight Blackbox');
    expect(rough.vibration!.sensors[0].magnitude!.p95).toBeGreaterThan(smooth.vibration!.sensors[0].magnitude!.p95 * 3);
    expect(rough.rate!.rollErrorDegS!.p95).toBeGreaterThan(smooth.rate!.rollErrorDegS!.p95 * 3);
    expect(rough.battery!.voltageMinV).toBeLessThan(rough.battery!.voltageMaxV!);
    expect(rough.throttle!.outputMax).toBeGreaterThan(0.5);
    expect(rough.durationSeconds).toBeCloseTo(4, 0);
    expect(rough.traces.rate.length).toBeLessThanOrEqual(600);
  });
});

describe('blackbox over MSP from a simulated Betaflight flight controller', () => {
  const timing = { mspMs: 300, cliMs: 2000, cliIdleMs: 15, pollMs: 15, rebootMs: 60 };
  const open: BetaflightDriver[] = [];
  afterEach(async () => { for (const d of open.splice(0)) await d.close(); });
  async function bench(options = {}) { const sim = new BetaflightSim(options); const [host, device] = loopback(); sim.attach(device); const driver = await BetaflightDriver.connect(host, { timing }); open.push(driver); return { sim, driver }; }

  it('reports storage use, downloads both flights, and analyses the one asked for', async () => {
    const { driver, sim } = await bench();
    const list = await driver.run('logs.list');
    expect(list.summary).toMatch(/KB of 16384 KB used/);
    const progress: number[] = [];
    const latest = await driver.run('logs.analyze', { progress: (_l, done) => progress.push(done!) });
    expect(latest.summary).toMatch(/Flight 2 of 2/);
    expect(progress.at(-1)).toBe(sim.flash.length);
    expect(driver.logs().map(l => l.id)).toEqual([1, 2]);
    const first = await driver.run('logs.analyze', { args: { log: 1 } });
    const a1 = (first.data as any).analysis, a2 = (latest.data as any).analysis;
    expect(a1.vibration.sensors[0].magnitude.p95).toBeGreaterThan(a2.vibration.sensors[0].magnitude.p95);
    expect(driver.lastLogAnalysis()?.id).toBe(1);
    await expect(driver.run('logs.analyze', { args: { log: 9 } })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('erases only with approval', async () => {
    const { driver, sim } = await bench();
    await expect(driver.run('logs.erase')).rejects.toMatchObject({ code: 'not_approved' });
    expect((await driver.run('logs.erase', { grant: { operation: 'logs.erase', conditions: [] } })).ok).toBe(true);
    expect(sim.flash.length).toBe(0);
    await expect(driver.run('logs.analyze')).rejects.toMatchObject({ code: 'invalid' });
  });
});
