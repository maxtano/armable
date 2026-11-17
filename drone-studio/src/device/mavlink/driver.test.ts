import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loopback } from '../transport';
import { ArdupilotSim, type ArdupilotSimOptions } from '../sim/ardupilot';
import type { Grant } from '../types';
import { MavlinkDriver } from './driver';

const timing = { heartbeatMs: 800, ackMs: 250, paramIdleMs: 60, echoMs: 150, quietMs: 30, restoreMs: 400, logIdleMs: 60, esc: { responseMs: 300, settleMs: 1, retryMs: 1 } };
const grant = (operation: string, ...conditions: Grant['conditions'][number][]): Grant => ({ operation, conditions });
const open: { sim: ArdupilotSim; driver: MavlinkDriver }[] = [];
async function bench(options: ArdupilotSimOptions = {}) {
  const [host, device] = loopback('sim');
  const sim = new ArdupilotSim(device, { tickMs: 10, ...options });
  const driver = await MavlinkDriver.connect(host, { timing });
  open.push({ sim, driver });
  return { sim, driver, host };
}
afterEach(async () => { for (const { sim, driver } of open.splice(0)) { sim.stop(); await driver.close(); } });
const until = async (check: () => boolean, ms = 1500) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 10)); } };

describe('MAVLink driver against a simulated ArduCopter', () => {
  it('identifies the aircraft and reads live state', async () => {
    const { driver } = await bench();
    await until(() => driver.identity.version !== 'unknown' && !!driver.state().battery?.cells && !!driver.state().rc);
    expect(driver.identity).toMatchObject({ stack: 'ardupilot', firmware: 'ArduCopter', version: '4.5.7', vehicle: 'quad' });
    const s = driver.state();
    expect(s).toMatchObject({ linkOk: true, armed: false, mode: 'Stabilize' });
    expect(s.battery).toMatchObject({ voltage: 15.8, cells: 4 });
    expect(s.gps).toMatchObject({ fix: 3, sats: 14 });
    expect(s.rc?.channels).toHaveLength(8);
    expect(s.sensors.gyro).toBe('ok');
  });

  it('refuses to connect when nothing answers', async () => {
    const [host] = loopback();
    await expect(MavlinkDriver.connect(host, { timing: { ...timing, heartbeatMs: 60 } })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('reads every setting, re-requesting the ones that went missing', async () => {
    const { driver, sim } = await bench({ dropParams: [3, 17, 40] });
    await driver.loadSettings();
    expect(driver.settingsLoaded()).toBe('complete');
    expect(driver.settings()).toHaveLength(sim.params.size);
    const type = driver.settings().find(s => s.id === 'param.FRAME_TYPE')!;
    expect(type).toMatchObject({ value: 12, type: 'enum', part: 'fc', rebootRequired: true });
    expect(type.options?.find(o => o.value === 12)?.label).toBe('Betaflight X');
    expect(driver.airframe()).toMatchObject({ known: true, label: 'Quad X · Betaflight order' });
    expect(driver.airframe().motors.map(m => m.spin)).toEqual(['cw', 'ccw', 'ccw', 'cw']);
  });

  it('writes a setting only with approval, and reports the readback', async () => {
    const { driver, sim } = await bench();
    await driver.loadSettings();
    await expect(driver.write([{ id: 'param.ATC_RAT_RLL_P', value: 0.12 }], {})).rejects.toMatchObject({ code: 'not_approved' });
    await expect(driver.write([{ id: 'param.ATC_RAT_RLL_P', value: 0.12 }], { grant: grant('motor.spin') })).rejects.toMatchObject({ code: 'not_approved' });
    const [result] = await driver.write([{ id: 'param.ATC_RAT_RLL_P', value: 0.12, expected: 0.135 }], { grant: grant('write') });
    expect(result).toMatchObject({ ok: true, requested: 0.12 });
    expect(result.before).toBeCloseTo(0.135, 5);
    expect(result.after).toBeCloseTo(0.12, 5);
    expect(sim.params.get('ATC_RAT_RLL_P')!.value).toBeCloseTo(0.12, 5);
  });

  it('accepts an option by its label, and rejects stale, out-of-range and unknown changes without writing', async () => {
    const { driver, sim } = await bench();
    await driver.loadSettings();
    const results = await driver.write([
      { id: 'param.FS_THR_ENABLE', value: 'Land' },
      { id: 'param.BATT_LOW_VOLT', value: 14.4, expected: 13.0 },
      { id: 'param.MOT_SPIN_ARM', value: 0.9 },
      { id: 'param.FRAME_CLASS', value: 1.5 },
      { id: 'param.NOT_A_PARAM', value: 1 },
    ], { grant: grant('write') });
    expect(results.map(r => r.ok)).toEqual([true, false, false, false, false]);
    expect(sim.params.get('FS_THR_ENABLE')!.value).toBe(3);
    expect(results[1].note).toMatch(/is now 14/);
    expect(sim.params.get('BATT_LOW_VOLT')!.value).toBeCloseTo(14.0, 4);
    expect(sim.params.get('MOT_SPIN_ARM')!.value).toBeCloseTo(0.1, 4);
  });

  it('will not write while armed', async () => {
    const { driver, sim } = await bench();
    await driver.loadSettings();
    sim.armed = true;
    await until(() => driver.state().armed);
    await expect(driver.write([{ id: 'param.RTL_ALT', value: 2000 }], { grant: grant('write') })).rejects.toMatchObject({ code: 'blocked' });
    expect(sim.params.get('RTL_ALT')!.value).toBe(1500);
  });

  it('runs observe-level checks freely and reports arming blocks in the aircraft\'s own words', async () => {
    const { driver } = await bench({ prearm: ['RC not found', 'Battery 1 low voltage failsafe'], rcPresent: false });
    await until(() => driver.state().sensors.receiver === 'bad');
    const prearm = await driver.run('prearm.check');
    expect(prearm.ok).toBe(false);
    expect(prearm.summary).toContain('RC not found');
    const full = await driver.run('diagnostics.full');
    expect(full.ok).toBe(false);
    expect((full.data as { check: string; ok: boolean | null }[]).find(c => c.check === 'radio.check')?.ok).toBe(false);
    expect((await driver.run('battery.check')).ok).toBe(true);
  });

  it('spins one motor only with the physical conditions confirmed, at a bounded throttle', async () => {
    const { driver, sim } = await bench();
    await expect(driver.run('motor.spin', { args: { motor: 3 } })).rejects.toMatchObject({ code: 'not_approved' });
    await expect(driver.run('motor.spin', { args: { motor: 3 }, grant: grant('motor.spin', 'propsRemoved') })).rejects.toMatchObject({ code: 'not_approved' });
    const ok = grant('motor.spin', 'propsRemoved', 'areaClear');
    await expect(driver.run('motor.spin', { args: { motor: 3, throttle: 60 }, grant: ok })).rejects.toMatchObject({ code: 'invalid' });
    await expect(driver.run('motor.spin', { args: { motor: 9 }, grant: ok })).rejects.toMatchObject({ code: 'invalid' });
    const result = await driver.run('motor.spin', { args: { motor: 3, seconds: 0.5 }, grant: ok });
    expect(result.ok).toBeNull();
    expect(sim.motorTests).toEqual([{ motor: 3, throttle: 5, seconds: 0.5 }]);
    await driver.stop();
    expect(sim.commands.filter(c => c.command === 209 && c.params[2] === 0)).toHaveLength(4);
  });

  it('never sends an arm command, whatever is asked', async () => {
    const { driver, sim } = await bench();
    await expect(driver.run('arm')).rejects.toMatchObject({ code: 'unsupported' });
    expect(driver.tests().some(t => /arm$|launch|takeoff/i.test(t.id))).toBe(false);
    expect(sim.commands.some(c => c.command === 400)).toBe(false);
  });

  it('calibrates level and shows what changed', async () => {
    const { driver } = await bench();
    const result = await driver.run('cal.level', { grant: grant('cal.level', 'level', 'still') });
    expect(result.ok).toBe(true);
    const data = result.data as { before: Record<string, number>; after: Record<string, number>; messages: string[] };
    expect(data.before.AHRS_TRIM_X).toBeCloseTo(-0.0143, 4);
    expect(data.after.AHRS_TRIM_X).toBeCloseTo(0, 4);
    expect(data.messages).toContain('Trim OK');
  });

  it('calibrates the compass with progress', async () => {
    const { driver } = await bench();
    const seen: number[] = [];
    const result = await driver.run('cal.compass', { grant: grant('cal.compass', 'batteryConnected'), progress: (_, done) => seen.push(done!) });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([25, 50, 75]);
  });

  it('reads the ESCs through passthrough after a quiet interval, and restores telemetry', async () => {
    const { driver, sim } = await bench();
    await driver.loadSettings();
    await until(() => !!driver.state().battery);
    const conditions = ['propsRemoved', 'directUsb', 'batteryConnected'] as const;
    const result = await driver.run('esc.read', { grant: grant('esc.read', ...conditions) });
    expect(result.ok).toBe(true);
    expect(driver.escs().map(e => e.firmware)).toEqual(['Bluejay', 'Bluejay', 'Bluejay', 'Bluejay']);
    expect(driver.settings().find(s => s.id === 'esc.3.direction')?.value).toBe('reversed');
    expect(sim.escBank.active).toBe(false);
    await until(() => driver.state().linkOk);
  });

  it('reverses one motor end to end, with a stale-value guard', async () => {
    const { driver, sim } = await bench();
    await driver.loadSettings();
    await until(() => !!driver.state().battery);
    const g = grant('write', 'propsRemoved', 'directUsb');
    const [stale] = await driver.write([{ id: 'esc.3.direction', value: 'normal', expected: 'normal' }], { grant: g });
    expect(stale.ok).toBe(false);
    expect(sim.escBank.images[2][0x1a0b]).toBe(2);
    const [done] = await driver.write([{ id: 'esc.3.direction', value: 'normal', expected: 'reversed' }], { grant: g });
    expect(done).toMatchObject({ ok: true, before: 'reversed', after: 'normal' });
    expect(sim.escBank.images[2][0x1a0b]).toBe(1);
    expect(sim.escBank.images.map(i => i[0x1a0b])).toEqual([1, 1, 1, 1]);
    await expect(driver.write([{ id: 'esc.3.direction', value: 'normal' }], { grant: grant('write') })).rejects.toMatchObject({ code: 'not_approved' });
  });

  it('explains what to change when passthrough is switched off', async () => {
    const { driver, sim } = await bench();
    sim.params.get('SERVO_BLH_AUTO')!.value = 0;
    await driver.loadSettings();
    await until(() => !!driver.state().battery);
    await expect(driver.run('esc.read', { grant: grant('esc.read', 'propsRemoved', 'directUsb', 'batteryConnected') })).rejects.toMatchObject({ code: 'blocked', hint: expect.stringContaining('SERVO_BLH_AUTO') });
  });

  it('flashes ESC firmware chosen by the person', async () => {
    const { driver } = await bench();
    await driver.loadSettings();
    await until(() => !!driver.state().battery);
    const file = Uint8Array.from(readFileSync('firmware/bluejay/J_H_40_24_v0.21.0.hex'));
    const result = await driver.run('esc.flash', { args: { esc: 2 }, prompt: async () => file, grant: grant('esc.flash', 'propsRemoved', 'directUsb', 'batteryConnected', 'firmwareMatchesBoard') });
    expect(result).toMatchObject({ ok: true, data: [{ esc: 2, ok: true, note: 'Bluejay 0.21' }] });
  });

  it('downloads and analyses a flight log, recovering a dropped chunk', async () => {
    const { driver, sim } = await bench({ dropLogChunk: 900 });
    const list = await driver.run('logs.list');
    expect(list.data).toEqual([{ id: 7, size: sim.log.length, time: 1760000000 }]);
    const result = await driver.run('logs.analyze');
    const { analysis } = result.data as { analysis: { bytes: number; vibration: { sensors: { vibeX: { peak: number } }[] } } };
    expect(analysis.bytes).toBe(sim.log.length);
    expect(analysis.vibration.sensors[0].vibeX.peak).toBeGreaterThan(30);
    expect(sim.logRequests).toBeGreaterThan(1);
    expect(driver.lastLogAnalysis()?.id).toBe(7);
  });

  it('queues a second operation behind the first instead of interleaving', async () => {
    const { driver } = await bench();
    const order: string[] = [];
    const first = driver.loadSettings().then(() => order.push('settings'));
    const second = driver.run('logs.list').then(() => order.push('logs'));
    await Promise.all([first, second]);
    expect(order).toEqual(['settings', 'logs']);
    expect(driver.settingsLoaded()).toBe('complete');
  });

  it('reports a pulled cable', async () => {
    const { driver, host } = await bench();
    const events: string[] = [];
    driver.on(e => events.push(e.type));
    host.drop();
    expect(events).toContain('closed');
    await expect(driver.loadSettings()).rejects.toMatchObject({ code: 'disconnected' });
  });
});
