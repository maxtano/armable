import { afterEach, describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { SimDfu } from './flash/dfu';
import { SimBootloader } from './flash/px4';
import { Runtime, type RuntimeOptions } from './runtime';
import { ardupilotDemo, betaflightDemo } from './sim/demo';
import { loopback } from './transport';
import type { Grant } from './types';

const options: RuntimeOptions = {
  detectMs: 600, reconnectMs: 2500,
  mav: { heartbeatMs: 800, ackMs: 250, paramIdleMs: 60, echoMs: 150, quietMs: 30, restoreMs: 400, logIdleMs: 60, esc: { responseMs: 300, settleMs: 1, retryMs: 1 } },
  bf: { mspMs: 300, cliMs: 2000, cliIdleMs: 15, pollMs: 15, rebootMs: 60, esc: { responseMs: 300, settleMs: 1, retryMs: 1 } },
};
const open: { runtime: Runtime; stop?: () => void }[] = [];
afterEach(async () => { for (const o of open.splice(0)) { await o.runtime.disconnect(); o.stop?.(); } });
async function ardupilot() { const source = ardupilotDemo({ tickMs: 10 }); const runtime = new Runtime(options); open.push({ runtime, stop: () => source.sim.stop() }); await runtime.connect(source); return { runtime, sim: source.sim }; }
async function betaflight() { const source = betaflightDemo(); const runtime = new Runtime(options); open.push({ runtime }); await runtime.connect(source); return { runtime, sim: source.sim }; }

describe('runtime', () => {
  it('works out which firmware is on the port', async () => {
    const a = await ardupilot(), b = await betaflight();
    expect(a.runtime.snapshot()).toMatchObject({ status: 'connected', demo: true, identity: { stack: 'ardupilot' } });
    expect(b.runtime.snapshot()).toMatchObject({ status: 'connected', identity: { stack: 'betaflight' } });
  });

  it('says so plainly when the port is silent', async () => {
    const runtime = new Runtime({ ...options, detectMs: 150 });
    open.push({ runtime });
    await expect(runtime.connect({ label: 'silent', demo: true, open: async () => loopback()[0] })).rejects.toMatchObject({ code: 'timeout' });
    expect(runtime.status).toBe('idle');
    await expect(runtime.load()).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('lets a relayed request observe but never write, spin, calibrate or flash', async () => {
    const { runtime, sim } = await ardupilot();
    await runtime.remote({ op: 'load' });
    expect((await runtime.remote({ op: 'run', id: 'battery.check' }) as { ok: boolean }).ok).toBe(true);
    for (const id of ['motor.spin', 'cal.level', 'esc.read', 'fc.restart', 'firmware.flash', 'esc.flash'])
      await expect(runtime.remote({ op: 'run', id, args: { motor: 1, grant: { operation: id, conditions: ['propsRemoved', 'areaClear'] } } })).rejects.toMatchObject({ code: 'not_approved' });
    expect(sim.motorTests).toEqual([]);
    expect(Object.keys(runtime).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(runtime)))).toContain('remote');
    // @ts-expect-error a relayed request has no write operation at all
    await expect(runtime.remote({ op: 'write', changes: [{ id: 'param.RTL_ALT', value: 1 }] })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('rejects a grant it did not mint, a grant for another operation, and a grant used twice', async () => {
    const { runtime, sim } = await ardupilot();
    await runtime.load();
    const change = [{ id: 'param.RTL_ALT', value: 2000 }];
    const forged: Grant = { operation: 'write', conditions: [] };
    await expect(runtime.write(change, forged)).rejects.toMatchObject({ code: 'not_approved' });
    await expect(runtime.write(change, runtime.approve('motor.spin'))).rejects.toMatchObject({ code: 'not_approved' });
    const real = runtime.approve('write');
    expect((await runtime.write(change, real))[0]).toMatchObject({ ok: true, after: 2000 });
    await expect(runtime.write([{ id: 'param.RTL_ALT', value: 3000 }], real)).rejects.toMatchObject({ code: 'not_approved' });
    expect(sim.params.get('RTL_ALT')!.value).toBe(2000);
  });

  it('on Betaflight, saves, waits for the restart, and confirms the value afterwards', async () => {
    const { runtime, sim } = await betaflight();
    const statuses: string[] = [];
    runtime.on(e => { if (e.type === 'status') statuses.push(runtime.status); });
    const [result] = await runtime.write([{ id: 'bf.d_roll', value: 38, expected: 40 }], runtime.approve('write'));
    expect(result).toMatchObject({ ok: true, after: 38, note: 'Saved and confirmed after the restart.' });
    expect(statuses).toEqual(['reconnecting', 'connected']);
    expect(sim.reboots).toBe(1);
    expect(runtime.snapshot().state?.linkOk).toBe(true);
  });

  it('on Betaflight, confirms values written in another form after the restart, and reads every setting again', async () => {
    const { runtime, sim } = await betaflight();
    await runtime.load();
    const results = await runtime.write([{ id: 'bf.osd_vbat_pos', value: '4,13,on' }, { id: 'bf.vtxtable', value: 'Tramp' }, { id: 'bf.failsafe_procedure', value: 'gps-rescue' }], runtime.approve('write'));
    expect(results.map(r => [r.id, r.ok, r.note])).toEqual([
      ['bf.osd_vbat_pos', true, 'Saved and confirmed after the restart.'], ['bf.vtxtable', true, 'Saved and confirmed after the restart.'], ['bf.failsafe_procedure', true, 'Saved and confirmed after the restart.'],
    ]);
    expect(results[1].after).toBe('Tramp');
    expect(runtime.snapshot().settingsLoaded).toBe('complete');
    expect(runtime.settings().find(x => x.id === 'bf.vtx_band')?.options?.length).toBe(6);
    expect(sim.settings.failsafe_procedure.value).toBe('GPS-RESCUE');
  });

  it('shares one settings read between two callers instead of answering "busy"', async () => {
    const { runtime } = await betaflight();
    await Promise.all([runtime.load(), runtime.load(), runtime.remote({ op: 'load' })]);
    expect(runtime.snapshot().settingsLoaded).toBe('complete');
  });

  it('restarts an ArduPilot flight controller and comes back', async () => {
    const { runtime, sim } = await ardupilot();
    const result = await runtime.run('fc.restart', {}, runtime.approve('fc.restart'));
    expect(result.summary).toBe('Restarted and reconnected.');
    expect(sim.reboots).toBe(1);
    expect(runtime.status).toBe('connected');
  });

  it('reverses a motor on each stack through the same call', async () => {
    for (const make of [ardupilot, betaflight]) {
      const { runtime, sim } = await make();
      await runtime.load();
      const conditions = ['propsRemoved', 'directUsb', 'batteryConnected'] as const;
      await runtime.run('esc.read', {}, runtime.approve('esc.read', [...conditions]));
      const reversed = runtime.settings().find(s => s.id.endsWith('.direction') && s.value === 'reversed')!;
      const [done] = await runtime.write([{ id: reversed.id, value: 'normal', expected: 'reversed' }], runtime.approve('write', ['propsRemoved', 'directUsb']));
      expect(done).toMatchObject({ ok: true, after: 'normal' });
      expect(sim.escBank.images.every(image => image[0x1a0b] === 1)).toBe(true);
    }
  });

  it('flashes Betaflight firmware through DFU after the person picks the file and the bootloader', async () => {
    const { runtime, sim } = await betaflight();
    const rec = (offset: number, type: number, bytes: number[]) => { const b = [bytes.length, offset >> 8, offset & 255, type, ...bytes]; return ':' + [...b, (256 - (b.reduce((s, x) => s + x, 0) % 256)) % 256].map(x => x.toString(16).padStart(2, '0')).join(''); };
    const hex = new TextEncoder().encode([rec(0, 4, [0x08, 0x00]), rec(0, 0, [1, 2, 3, 4, 5, 6, 7, 8]), rec(0, 1, [])].join('\n'));
    const dfu = new SimDfu();
    const asked: string[] = [];
    const conditions = ['propsRemoved', 'batteryDisconnected', 'firmwareMatchesBoard'] as const;
    const result = await runtime.run('firmware.flash', {}, runtime.approve('firmware.flash', [...conditions]), async request => { asked.push(request.kind); return request.kind === 'file' ? hex : dfu; });
    expect(result.ok).toBe(true);
    expect(asked).toEqual(['file', 'dfu']);
    expect(sim.inBootloader).toBe(true);
    expect([...dfu.memory.subarray(0, 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(dfu.started).toBe(true);
    expect(runtime.status).toBe('idle');
  });

  it('refuses a bad firmware file before the flight controller leaves normal operation', async () => {
    const { runtime, sim } = await betaflight();
    const conditions = ['propsRemoved', 'batteryDisconnected', 'firmwareMatchesBoard'] as const;
    await expect(runtime.run('firmware.flash', {}, runtime.approve('firmware.flash', [...conditions]), async () => new TextEncoder().encode('garbage'))).rejects.toMatchObject({ code: 'invalid' });
    expect(sim.inBootloader).toBe(false);
    expect(runtime.status).toBe('connected');
  });

  it('flashes ArduPilot firmware through the serial bootloader', async () => {
    const { runtime, sim } = await ardupilot();
    const image = Uint8Array.from({ length: 600 }, (_, i) => i & 255);
    const apj = new TextEncoder().encode(JSON.stringify({ board_id: 1013, image_size: 600, image: Buffer.from(deflateSync(image)).toString('base64') }));
    const [host, device] = loopback();
    const boot = new SimBootloader(device);
    const conditions = ['propsRemoved', 'batteryDisconnected', 'firmwareMatchesBoard'] as const;
    const result = await runtime.run('firmware.flash', {}, runtime.approve('firmware.flash', [...conditions]), async request => request.kind === 'file' ? apj : host);
    expect(result.ok).toBe(true);
    expect(sim.inBootloader).toBe(true);
    expect([...boot.flash.subarray(0, 600)]).toEqual([...image]);
    expect(boot.rebooted).toBe(true);
  });

  it('goes idle when the cable is pulled, without trying to reconnect', async () => {
    const source = betaflightDemo();
    let host: Awaited<ReturnType<typeof source.open>> | undefined;
    const runtime = new Runtime(options);
    open.push({ runtime });
    await runtime.connect({ ...source, open: async () => (host = await source.open()) });
    (host as unknown as { drop(): void }).drop();
    await new Promise(r => setTimeout(r, 50));
    expect(runtime.status).toBe('idle');
    expect(runtime.snapshot().tests).toEqual([]);
  });
});
