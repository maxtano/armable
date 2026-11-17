import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DeviceError, equal } from '../bytes';
import { loopback } from '../transport';
import { EscBank } from '../sim/esc';
import { BB2, encodeEscField, escSettings, flashEsc, FourWay, parseEscHex, patchEscSettings, readEsc } from './fourway';
import { decodeEscSettings } from '../../aircraft/esc-protocol';

const fast = { responseMs: 300, settleMs: 1, retryMs: 1 };
function bench(bank = new EscBank('BTFL')) {
  const [host, device] = loopback();
  device.onData(chunk => { const reply = bank.handle(chunk); if (reply?.length) void device.write(reply); });
  return { link: new FourWay(host, fast), bank, host };
}

describe('ESC four-way interface', () => {
  it('enters passthrough, identifies every ESC and reads its settings', async () => {
    const { link, bank } = bench(new EscBank('ARDU', ['Bluejay', 'BLHeli_S', 'Bluejay', 'Bluejay'], [1, 2, 1, 4]));
    expect(Array.from(await link.msp(1))).toEqual([0, 1, 46]);
    expect(new TextDecoder().decode(await link.msp(2))).toBe('ARDU');
    expect((await link.msp(245))[0]).toBe(4);
    const reads = [];
    for (let i = 0; i < 4; i++) { reads.push(await readEsc(link, i, () => 1)); await link.reset(i); }
    await link.exit();
    expect(reads.map(r => r.info.firmware)).toEqual(['Bluejay', 'BLHeli_S', 'Bluejay', 'Bluejay']);
    expect(reads.map(r => escSettings(r.info, r.block!).find(s => s.name === 'direction')!.value)).toEqual(['normal', 'reversed', 'normal', 'bidirectional reversed']);
    expect(reads[0].info).toMatchObject({ version: '0.21', layout: 'J-H-40', writable: true });
    expect(bank.active).toBe(false);
  });

  it('agrees with the original bench-tested decoder', async () => {
    const { link } = bench();
    await link.msp(245);
    const read = await readEsc(link, 2, () => 1);
    const old = decodeEscSettings(3, 0xe8b2, 1, Buffer.from(read.block!));
    expect(old.firmware).toBe(read.info.firmware);
    expect(old.direction?.toLowerCase()).toBe(escSettings(read.info, read.block!).find(s => s.name === 'direction')!.value);
    expect(old.layout).toBe(read.info.layout);
  });

  it('reverses one motor and leaves every other byte alone', async () => {
    const { link, bank } = bench();
    await link.msp(245);
    const read = await readEsc(link, 2, () => 1);
    const before = Uint8Array.from(bank.images[2]);
    link.allowWrites = true;
    const page = await patchEscSettings(link, [encodeEscField('direction', 'normal', read.info.firmware)]);
    expect(page[0x0b]).toBe(1);
    const changed = [...bank.images[2]].flatMap((byte, i) => byte !== before[i] ? [i] : []);
    expect(changed).toEqual([BB2.settings + 0x0b]);
    expect(equal(bank.images[2].subarray(BB2.bootloader), before.subarray(BB2.bootloader))).toBe(true);
  });

  it('refuses to write without approval, outside the application area, or with a value that is not allowed', async () => {
    const { link } = bench();
    await link.msp(245);
    const read = await readEsc(link, 0, () => 1);
    await expect(patchEscSettings(link, [{ offset: 0x0b, byte: 2 }])).rejects.toMatchObject({ code: 'not_approved' });
    link.allowWrites = true;
    await expect(link.write(BB2.bootloader, Uint8Array.of(0))).rejects.toMatchObject({ code: 'not_approved' });
    await expect(link.erasePage(14)).rejects.toMatchObject({ code: 'not_approved' });
    expect(() => encodeEscField('direction', 'sideways', read.info.firmware)).toThrow(DeviceError);
    expect(() => encodeEscField('brake_on_stop', 'on', 'Bluejay')).toThrow(/not supported/);
  });

  it('retries a negative answer when selecting an ESC, and times out cleanly when nothing answers', async () => {
    const { link, bank } = bench();
    await link.msp(245);
    bank.nackNext = 2;
    expect((await link.init(0)).signature).toBe(0xe8b2);
    const [silent] = loopback();
    await expect(new FourWay(silent, { ...fast, responseMs: 30 }).msp(1)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('flashes the bundled Bluejay release, keeps direction, and never touches the bootloader', async () => {
    const { link, bank } = bench(new EscBank('BTFL', ['BLHeli_S'], [2]));
    await link.msp(245);
    const read = await readEsc(link, 0, () => 1);
    const bootloader = Uint8Array.from(bank.images[0].subarray(BB2.bootloader));
    const firmware = parseEscHex(readFileSync('firmware/bluejay/J_H_40_24_v0.21.0.hex', 'utf8'));
    link.allowWrites = true;
    const steps: string[] = [];
    await flashEsc(link, read, firmware, label => steps.push(label));
    const after = await readEsc(link, 0, () => 2);
    expect(after.info).toMatchObject({ firmware: 'Bluejay', version: '0.21' });
    expect(escSettings(after.info, after.block!).find(s => s.name === 'direction')!.value).toBe('reversed');
    expect(equal(bank.images[0].subarray(BB2.bootloader), bootloader)).toBe(true);
    expect(equal(bank.images[0].subarray(0, BB2.settings), firmware.subarray(0, BB2.settings))).toBe(true);
    expect(steps[0]).toBe('Reading current firmware');
  });

  it('refuses firmware built for a different ESC layout', async () => {
    const { link, bank } = bench(new EscBank('BTFL', ['BLHeli_S'], [1]));
    bank.images[0].set(new TextEncoder().encode('#A_L_00#'), BB2.settings + 0x40);
    await link.msp(245);
    const read = await readEsc(link, 0, () => 1);
    link.allowWrites = true;
    const firmware = parseEscHex(readFileSync('firmware/bluejay/J_H_40_24_v0.21.0.hex', 'utf8'));
    const image = Uint8Array.from(bank.images[0]);
    await expect(flashEsc(link, read, firmware, () => {})).rejects.toMatchObject({ code: 'mismatch' });
    expect(equal(bank.images[0], image)).toBe(true);
  });
});
