import { afterEach, describe, expect, it } from 'vitest';
import { loopback, type LoopbackEnd } from '../transport';
import { BetaflightSim, type BetaflightSimOptions } from '../sim/betaflight';
import type { Grant } from '../types';
import { parseDump, parseGet, restoreLines, safeValue } from './cli';
import { BetaflightDriver } from './driver';

const timing = { mspMs: 300, cliMs: 2000, cliIdleMs: 15, pollMs: 15, rebootMs: 60, esc: { responseMs: 300, settleMs: 1, retryMs: 1 } };
const grant = (operation: string, ...conditions: Grant['conditions'][number][]): Grant => ({ operation, conditions });
const open: BetaflightDriver[] = [];
async function plug(sim: BetaflightSim) {
  const [host, device] = loopback('sim');
  sim.attach(device);
  const driver = await BetaflightDriver.connect(host, { timing });
  open.push(driver);
  return { driver, host: host as LoopbackEnd };
}
async function bench(options: BetaflightSimOptions = {}) { const sim = new BetaflightSim(options); return { sim, ...(await plug(sim)) }; }
afterEach(async () => { for (const d of open.splice(0)) await d.close(); });
const until = async (check: () => boolean, ms = 1500) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 10)); } };

describe('Betaflight console parsing', () => {
  it('reads a dump with profiles, ports and modes', () => {
    const dump = parseDump(['# dump', 'batch start', 'board_name X', 'feature -GPS', 'serial 0 1 115200 57600 0 115200', 'aux 0 0 0 1700 2100 0 0', 'map AETR1234', 'set gyro_lpf1_static_hz = 250', 'profile 0', 'set p_roll = 45', 'rateprofile 0', 'set roll_rc_rate = 7', 'batch end'].join('\r\n'));
    expect(dump.settings).toEqual([{ name: 'gyro_lpf1_static_hz', value: '250', scope: undefined }, { name: 'p_roll', value: '45', scope: 'profile 0' }, { name: 'roll_rc_rate', value: '7', scope: 'rateprofile 0' }]);
    expect(dump).toMatchObject({ serial: { '0': '1 115200 57600 0 115200' }, aux: { '0': '0 0 1700 2100 0 0' }, map: 'AETR1234', board: 'X' });
  });
  it('reads ranges, allowed values and defaults from get', () => {
    const [a, b] = parseGet('profile 0\np_roll = 45\nAllowed range: 0 - 250\nDefault value: 45\n\nmotor_pwm_protocol = DSHOT600\nAllowed values: PWM, DSHOT300, DSHOT600\n');
    expect(a).toMatchObject({ name: 'p_roll', value: '45', scope: 'profile 0', min: 0, max: 250, default: '45' });
    expect(b).toMatchObject({ name: 'motor_pwm_protocol', options: ['PWM', 'DSHOT300', 'DSHOT600'] });
    expect(b.scope).toBeUndefined();
  });
  it('refuses values that could carry a second command', () => {
    for (const bad of ['1\nsave', '1; defaults', '5 # x', 'a\rb', '$(x)']) expect(() => safeValue(bad)).toThrow();
    expect(safeValue(' DSHOT600 ')).toBe('DSHOT600');
  });
  it('restores only lines that belong in a backup', () => {
    const { lines, rejected } = restoreLines('# diff all\nbatch start\nset p_roll = 50\nfeature -GPS\nserial 1 64 115200 57600 0 115200\nbl\nflash_erase\nmotor 0 2000\nbatch end\n');
    expect(lines).toEqual(['set p_roll = 50', 'feature -GPS', 'serial 1 64 115200 57600 0 115200']);
    expect(rejected).toEqual(['bl', 'flash_erase', 'motor 0 2000']);
  });
});

describe('Betaflight driver against a simulated flight controller', () => {
  it('identifies the aircraft and reads live state', async () => {
    const { driver } = await bench();
    expect(driver.identity).toMatchObject({ stack: 'betaflight', firmware: 'Betaflight', version: '4.5.1', board: 'SPEEDYBEEF405V4', craftName: 'DEMO5', vehicle: 'quad' });
    const s = driver.state();
    expect(s).toMatchObject({ linkOk: true, armed: false });
    expect(s.battery).toMatchObject({ voltage: 16.1, cells: 4 });
    expect(s.rc?.channels).toHaveLength(8);
    expect(s.sensors).toMatchObject({ gyro: 'ok', accel: 'ok', compass: 'absent' });
    expect(driver.airframe()).toMatchObject({ known: true, label: 'Quad X' });
    expect(driver.airframe().motors.map(m => m.spin)).toEqual(['cw', 'ccw', 'ccw', 'cw']);
    expect(s.armingBlocks).toEqual([]);
  });

  it('reads every setting from the console, including features, ports and modes', async () => {
    const { driver, sim } = await bench();
    await driver.loadSettings();
    expect(driver.settingsLoaded()).toBe('complete');
    const all = driver.settings();
    expect(all.filter(s => !s.id.includes('.feature.') && !s.id.includes('.serial.') && !s.id.includes('.aux.') && s.id !== 'bf.map')).toHaveLength(Object.keys(sim.settings).length);
    expect(all.find(s => s.id === 'bf.p_roll')).toMatchObject({ value: 45, type: 'number', part: 'tuning', scope: 'profile 0', title: 'Roll P' });
    expect(all.find(s => s.id === 'bf.dshot_bidir')).toMatchObject({ value: 'ON', type: 'bool', part: 'motors' });
    expect(all.find(s => s.id === 'bf.motor_pwm_protocol')).toMatchObject({ type: 'enum', options: expect.arrayContaining([{ value: 'DSHOT300', label: 'DSHOT300' }]) });
    expect(all.find(s => s.id === 'bf.p_roll')).toMatchObject({ min: 0, max: 250 });
    expect(all.find(s => s.id === 'bf.feature.GPS')).toMatchObject({ value: 'ON', type: 'bool' });
    expect(all.find(s => s.id === 'bf.feature.LED_STRIP')).toMatchObject({ value: 'OFF' });
    expect(all.find(s => s.id === 'bf.serial.1')).toMatchObject({ value: '64 115200 57600 0 115200', part: 'ports' });
    expect(all.find(s => s.id === 'bf.aux.0')).toMatchObject({ value: '0 0 1700 2100 0 0' });
    expect(sim.reboots).toBe(0);
    await until(() => driver.state().linkOk);
  });

  it('writes settings with approval, saves, and the saved values survive the restart', async () => {
    const { driver, sim } = await bench();
    await expect(driver.write([{ id: 'bf.p_roll', value: 50 }], {})).rejects.toMatchObject({ code: 'not_approved' });
    const events: string[] = [];
    driver.on(e => events.push(e.type));
    const results = await driver.write([
      { id: 'bf.p_roll', value: 50, expected: 45 },
      { id: 'bf.motor_pwm_protocol', value: 'DSHOT300' },
      { id: 'bf.feature.LED_STRIP', value: 'ON' },
      { id: 'bf.serial.2', value: '0 115200 57600 0 115200' },
    ], { grant: grant('write') });
    expect(results.map(r => r.ok)).toEqual([true, true, true, true]);
    expect(results[0]).toMatchObject({ before: '45', after: '50' });
    expect(events).toContain('reconnect-needed');
    expect(sim.reboots).toBe(1);
    const again = await plug(sim);
    const [p, proto, led, port] = await again.driver.refresh(['bf.p_roll', 'bf.motor_pwm_protocol', 'bf.feature.LED_STRIP', 'bf.serial.2']);
    expect([p.value, proto.value, led.value, port.value]).toEqual([50, 'DSHOT300', 'ON', '0 115200 57600 0 115200']);
    expect(p).toMatchObject({ min: 0, max: 250 });
  });

  it('does not save when every change is refused, and says what is allowed', async () => {
    const { driver, sim } = await bench();
    const results = await driver.write([
      { id: 'bf.p_roll', value: 900 },
      { id: 'bf.motor_pwm_protocol', value: 'WARP' },
      { id: 'bf.p_pitch', value: 50, expected: 99 },
      { id: 'bf.not_a_setting', value: 1 },
      { id: 'bf.craft_name', value: 'x\nsave' },
    ], { grant: grant('write') });
    expect(results.every(r => !r.ok)).toBe(true);
    expect(results[0].note).toMatch(/Allowed: 0 to 250/);
    expect(results[1].note).toMatch(/DSHOT600/);
    expect(results[2].note).toMatch(/is now 47/);
    expect(sim.cliLog).not.toContain('save');
    expect(sim.settings.p_roll.value).toBe('45');
    expect(sim.reboots).toBe(0);
  });

  it('copes with older firmware that restarts when the console is left', async () => {
    const { driver, sim } = await bench({ rebootOnExit: true });
    const events: string[] = [];
    driver.on(e => events.push(e.type));
    await driver.loadSettings();
    expect(driver.settings().length).toBeGreaterThan(50);
    expect(sim.reboots).toBe(1);
    expect(events).toContain('reconnect-needed');
  });

  it('explains arming blocks in plain words and ignores the ones this connection causes', async () => {
    const { driver } = await bench({ rxLoss: true });
    const prearm = await driver.run('prearm.check');
    expect(prearm.ok).toBe(false);
    expect(prearm.summary).toContain('No signal from the receiver');
    expect(prearm.summary).not.toMatch(/MSP|CLI/);
    const full = await driver.run('diagnostics.full');
    expect((full.data as { check: string; ok: boolean | null }[]).filter(c => c.ok === false).map(c => c.check).sort()).toEqual(['prearm.check', 'radio.check']);
  });

  it('spins one motor at a bounded throttle and always sends stop', async () => {
    const { driver, sim } = await bench();
    await expect(driver.run('motor.spin', { args: { motor: 2 } })).rejects.toMatchObject({ code: 'not_approved' });
    const g = grant('motor.spin', 'propsRemoved', 'areaClear');
    await expect(driver.run('motor.spin', { args: { motor: 2, throttle: 40 }, grant: g })).rejects.toMatchObject({ code: 'invalid' });
    await driver.run('motor.spin', { args: { motor: 2, throttle: 6, seconds: 0.5 }, grant: g });
    expect(sim.motorLog[0]).toEqual([1000, 1060, 1000, 1000, 1000, 1000, 1000, 1000]);
    expect(sim.motorLog.at(-1)).toEqual(Array(8).fill(1000));
    expect(Math.max(...sim.motorLog.flat())).toBe(1060);
  });

  it('reads and reverses an ESC through passthrough, then returns to live data', async () => {
    const { driver, sim } = await bench();
    const read = await driver.run('esc.read', { grant: grant('esc.read', 'propsRemoved', 'directUsb', 'batteryConnected') });
    expect(read.ok).toBe(true);
    expect(driver.settings().find(s => s.id === 'esc.2.direction')?.value).toBe('reversed');
    const [done] = await driver.write([{ id: 'esc.2.direction', value: 'normal', expected: 'reversed' }], { grant: grant('write', 'propsRemoved', 'directUsb') });
    expect(done).toMatchObject({ ok: true, before: 'reversed', after: 'normal' });
    expect(sim.escBank.images.map(i => i[0x1a0b])).toEqual([1, 1, 1, 1]);
    expect(sim.reboots).toBe(0);
    await until(() => driver.state().linkOk);
    expect((await driver.run('link.check')).ok).toBe(true);
  });

  it('calibrates the accelerometer and takes a full snapshot with a restorable backup', async () => {
    const { driver, sim } = await bench();
    expect((await driver.run('cal.accel', { grant: grant('cal.accel', 'level', 'still') })).ok).toBe(true);
    expect(sim.calibrations).toEqual(['accel']);
    const snap = await driver.run('settings.snapshot');
    const data = snap.data as { values: Record<string, unknown>; backup: string };
    expect(data.values.p_roll).toBe(45);
    expect(restoreLines(data.backup).rejected).toEqual([]);
  });

  it('restores a backup, refusing a file that contains anything but settings', async () => {
    const { driver, sim } = await bench();
    const g = grant('settings.restore');
    const bad = new TextEncoder().encode('set p_roll = 60\nflash_erase\n');
    await expect(driver.run('settings.restore', { grant: g, prompt: async () => bad })).rejects.toMatchObject({ code: 'invalid' });
    expect(sim.cliLog).toEqual([]);
    const good = new TextEncoder().encode('# diff all\nbatch start\nset p_roll = 60\nfeature -GPS\nbatch end\n');
    const result = await driver.run('settings.restore', { grant: g, prompt: async () => good });
    expect(result.ok).toBe(true);
    expect(sim.settings.p_roll.value).toBe('60');
    expect(sim.features.has('GPS')).toBe(false);
    expect(sim.reboots).toBe(1);
  });

  it('will not write or spin while armed', async () => {
    const { driver, sim } = await bench();
    sim.armed = true;
    await until(() => driver.state().armed);
    await expect(driver.write([{ id: 'bf.p_roll', value: 50 }], { grant: grant('write') })).rejects.toMatchObject({ code: 'blocked' });
    await expect(driver.run('motor.spin', { args: { motor: 1 }, grant: grant('motor.spin', 'propsRemoved', 'areaClear') })).rejects.toMatchObject({ code: 'blocked' });
    expect(sim.motorLog).toEqual([]);
  });
});
