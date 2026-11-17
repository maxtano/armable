import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { BetaflightDriver } from '../betaflight/driver';
import { ElrsReceiverSim, SimEspRom } from '../sim/esp';
import { BetaflightSim } from '../sim/betaflight';
import { loopback } from '../transport';
import { crc8DvbS2, elrsCommand, esp8266EraseSize, espChecksum, flashEspDevice, SlipReader, slipEncode } from './esp';
import { md5 } from './md5';

const timing = { commandMs: 400, eraseMsPerMb: 1000, syncTries: 3 };
function wired(rom: SimEspRom | ElrsReceiverSim) {
  const [host, device] = loopback();
  device.onData(chunk => { const r = rom.handle(chunk); if (r.length) void device.write(r); });
  return host;
}
const firmware = (size: number, headerAt = 0) => { const b = Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff); b[headerAt] = 0xe9; return b; };

describe('esptool protocol pieces', () => {
  it('frames and unframes SLIP, including the escape bytes', () => {
    const packet = Uint8Array.of(1, 0xc0, 2, 0xdb, 3);
    const framed = slipEncode(packet);
    expect([...framed]).toEqual([0xc0, 1, 0xdb, 0xdc, 2, 0xdb, 0xdd, 3, 0xc0]);
    const r = new SlipReader();
    expect([...r.push(framed.subarray(0, 4)), ...r.push(framed.subarray(4))].map(f => [...f])).toEqual([[...packet]]);
  });
  it('computes MD5 exactly as the standard', () => {
    for (const s of ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'x'.repeat(1000)]) expect(md5(new TextEncoder().encode(s))).toBe(createHash('md5').update(s).digest('hex'));
    const big = firmware(70_001);
    expect(md5(big)).toBe(createHash('md5').update(big).digest('hex'));
  });
  it('uses the ROM checksum and the ESP8266 erase-size workaround from esptool', () => {
    expect(espChecksum(Uint8Array.of(1, 2, 3))).toBe(0xef ^ 1 ^ 2 ^ 3);
    // esptool ESP8266ROM.get_erase_size for offset 0: 0x1000 -> 0x1000, 0x10000 -> 0x8000, 0x100000 -> 0xf0000.
    expect([esp8266EraseSize(0, 0x1000), esp8266EraseSize(0, 0x10000), esp8266EraseSize(0, 0x100000)]).toEqual([0x1000, 0x8000, 0xf0000]);
  });
  it('builds the ExpressLRS commands byte for byte as ExpressLRS does', () => {
    const payload = [0xec, 0x09, 0x32, 0x62, 0x6c, ...new TextEncoder().encode('ESP82')];
    expect([...elrsCommand('bootloader', 'ESP82')]).toEqual([...payload, crc8DvbS2(payload.slice(2))]);
    expect([...elrsCommand('bind')].slice(0, 5)).toEqual([0xec, 0x04, 0x32, 0x62, 0x64]);
  });
});

describe('flashing a radio plugged in over USB', () => {
  it('writes an ESP8285 receiver, and says it cannot read back', async () => {
    const rom = new SimEspRom('ESP8266');
    const image = firmware(50_000);
    const steps = new Set<string>();
    const r = await flashEspDevice(wired(rom), image, 0, l => steps.add(l), timing);
    expect(r).toMatchObject({ chip: 'ESP8266', bytes: 50_000, verified: false });
    expect([...rom.flash.subarray(0, 50_000)]).toEqual([...image]);
    expect(rom.eraseRequests).toEqual([esp8266EraseSize(0, 50_000)]);
    expect(rom.started).toBe(true);
    expect([...steps]).toEqual(['Connecting', 'Erasing', 'Writing']);
  });
  it('writes and verifies an ESP32 merged image, and an ESP32-C6 ground radio', async () => {
    const esp32 = new SimEspRom('ESP32');
    const merged = firmware(9000, 0x1000);
    expect(await flashEspDevice(wired(esp32), merged, 0, undefined, timing)).toMatchObject({ chip: 'ESP32', verified: true });
    const c6 = new SimEspRom('ESP32-C6');
    expect(await flashEspDevice(wired(c6), firmware(20_000), 0, undefined, timing)).toMatchObject({ chip: 'ESP32-C6', verified: true });
    expect([...c6.flash.subarray(0, 20_000)]).toEqual([...firmware(20_000)]);
  });
  it('catches a byte that did not write correctly', async () => {
    const rom = new SimEspRom('ESP32');
    rom.corruptAt = 3000;
    await expect(flashEspDevice(wired(rom), firmware(8000, 0x1000), 0, undefined, timing)).rejects.toMatchObject({ code: 'mismatch' });
  });
  it('refuses a file that is not ESP firmware before writing, and a chip it does not know', async () => {
    const rom = new SimEspRom('ESP32-C3');
    await expect(flashEspDevice(wired(rom), new Uint8Array(4096).fill(1), 0, undefined, timing)).rejects.toMatchObject({ code: 'mismatch' });
    expect(rom.eraseRequests).toEqual([]);
    const silent = loopback()[0];
    await expect(flashEspDevice(silent, firmware(4096), 0, undefined, { ...timing, syncTries: 1 })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('ExpressLRS receivers through a Betaflight flight controller', () => {
  const bfTiming = { mspMs: 300, cliMs: 2000, cliIdleMs: 15, pollMs: 15, rebootMs: 60 };
  async function plug() { const sim = new BetaflightSim(); const [host, device] = loopback(); sim.attach(device); return { sim, driver: await BetaflightDriver.connect(host, { timing: bfTiming }) }; }
  it('puts the receiver into bind mode, with approval, and asks for a power cycle', async () => {
    const { sim, driver } = await plug();
    await expect(driver.run('receiver.bind')).rejects.toMatchObject({ code: 'not_approved' });
    const closed: string[] = [];
    driver.on(e => { if (e.type === 'closed') closed.push(e.reason); });
    const r = await driver.run('receiver.bind', { grant: { operation: 'receiver.bind', conditions: [] } });
    expect(r.summary).toMatch(/bind mode/);
    expect(sim.passthrough).toEqual({ port: '1', baud: 420000 });
    expect(sim.receiver.bindMode).toBe(true);
    expect(closed[0]).toMatch(/unplug and replug/);
  });
  it('flashes the receiver through serial passthrough', async () => {
    const { sim, driver } = await plug();
    const image = firmware(30_000);
    const r = await driver.run('receiver.flash', { prompt: async () => image, grant: { operation: 'receiver.flash', conditions: ['firmwareMatchesBoard'] } });
    expect(r).toMatchObject({ ok: null, data: { chip: 'ESP8266', verified: false } });
    expect(sim.receiver.mode).toBe('rom');
    expect([...sim.receiver.rom.flash.subarray(0, 30_000)]).toEqual([...image]);
    expect(sim.receiver.rom.started).toBe(true);
  });
  it('refuses when the receiver is not on a CRSF serial port', async () => {
    const { sim, driver } = await plug();
    sim.settings.serialrx_provider.value = 'SBUS';
    await expect(driver.run('receiver.bind', { grant: { operation: 'receiver.bind', conditions: [] } })).rejects.toMatchObject({ code: 'unsupported', hint: expect.stringContaining('CRSF') });
    expect(sim.passthrough).toBeUndefined();
    await driver.close();
  });
});
