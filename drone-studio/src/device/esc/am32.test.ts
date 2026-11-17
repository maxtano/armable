import { describe, expect, it } from 'vitest';
import { equal } from '../bytes';
import { loopback } from '../transport';
import { EscBank } from '../sim/esc';
import { AM32_FIELDS, parseAm32Hex } from './am32';
import { encodeEscField, escSettings, flashEsc, FourWay, patchEscSettings, readEsc } from './fourway';

const fast = { responseMs: 300, settleMs: 1, retryMs: 1 };
function bench(kinds: ('BLHeli_S' | 'Bluejay' | 'AM32')[] = ['AM32', 'AM32', 'Bluejay', 'AM32'], dirs = [1, 2, 1, 1]) {
  const bank = new EscBank('BTFL', kinds, dirs);
  const [host, device] = loopback();
  device.onData(chunk => { const reply = bank.handle(chunk); if (reply?.length) void device.write(reply); });
  return { link: new FourWay(host, fast), bank };
}
function hexFile(base: number, data: Uint8Array): string {
  const rec = (offset: number, type: number, bytes: number[]) => { const b = [bytes.length, offset >> 8, offset & 255, type, ...bytes]; return ':' + [...b, (256 - (b.reduce((s, x) => s + x, 0) % 256)) % 256].map(x => x.toString(16).padStart(2, '0')).join(''); };
  const lines = [rec(0, 4, [base >>> 24, (base >>> 16) & 255])];
  for (let at = 0; at < data.length; at += 16) lines.push(rec(((base & 0xffff) + at) & 0xffff, 0, [...data.subarray(at, at + 16)]));
  return [...lines, rec(0, 1, [])].join('\n');
}

describe('AM32 ESCs', () => {
  it('are identified and their settings decoded, next to a Bluejay ESC', async () => {
    const { link } = bench();
    await link.msp(245);
    const a = await readEsc(link, 0, () => 1), b = await readEsc(link, 1, () => 1), c = await readEsc(link, 2, () => 1);
    expect(a.info).toMatchObject({ firmware: 'AM32', version: '2.13', layout: 'T-MOTOR 55A', mcu: 'STM32F051', interfaceMode: 4, writable: true });
    expect(c.info.firmware).toBe('Bluejay');
    const s = Object.fromEntries(escSettings(a.info, a.block!).map(x => [x.name, x.value]));
    expect(s).toMatchObject({ direction: 'normal', bidirectional: 'off', timing: '15°', pwm_frequency: 24, motor_kv: 2220, motor_poles: 14, beep_strength: 5, low_voltage_threshold: 3.3, temperature_limit: 141, current_limit: 204 });
    expect(Object.fromEntries(escSettings(b.info, b.block!).map(x => [x.name, x.value])).direction).toBe('reversed');
    expect(escSettings(a.info, a.block!)).toHaveLength(AM32_FIELDS.length);
  });

  it('reverse a motor and change the KV, leaving every other byte as it was', async () => {
    const { link, bank } = bench();
    await link.msp(245);
    const read = await readEsc(link, 1, () => 1);
    const before = Uint8Array.from(bank.images[1]);
    link.allowWrites = true;
    await patchEscSettings(link, [encodeEscField('direction', 'normal', 'AM32'), encodeEscField('motor_kv', 1940, 'AM32')], read);
    const changed = [...bank.images[1]].flatMap((v, i) => v !== before[i] ? [i] : []);
    expect(changed).toEqual([0x7c00 + 0x11, 0x7c00 + 0x1a]);
    const after = await readEsc(link, 1, () => 2);
    expect(Object.fromEntries(escSettings(after.info, after.block!).map(x => [x.name, x.value]))).toMatchObject({ direction: 'normal', motor_kv: 1940 });
    expect(equal(bank.images[1].subarray(0, 0x1000), before.subarray(0, 0x1000))).toBe(true);
  });

  it('refuse values outside the range, writes without approval, and writes into the bootloader', async () => {
    const { link } = bench();
    await link.msp(245);
    const read = await readEsc(link, 0, () => 1);
    expect(() => encodeEscField('pwm_frequency', 99, 'AM32')).toThrow(/8 to 48/);
    expect(() => encodeEscField('brake_on_stop', 'maybe', 'AM32')).toThrow(/not allowed/);
    expect(() => encodeEscField('demag', 'low', 'AM32')).toThrow(/does not exist on AM32/);
    await expect(patchEscSettings(link, [{ offset: 0x11, byte: 1 }], read)).rejects.toMatchObject({ code: 'not_approved' });
    link.allowWrites = true;
    await expect(link.writeArm(0x0800, Uint8Array.of(0))).rejects.toMatchObject({ code: 'not_approved' });
  });

  it('flash new firmware, verify it, keep the settings and never touch the bootloader', async () => {
    const { link, bank } = bench(['AM32']);
    await link.msp(245);
    const read = await readEsc(link, 0, () => 1);
    const bootloader = Uint8Array.from(bank.images[0].subarray(0, 0x1000));
    const body = Uint8Array.from({ length: 0x3000 }, (_, i) => (i * 7 + 1) & 0xff);
    body.set([0x00, 0x20, 0x00, 0x20], 0);
    const image = parseAm32Hex(hexFile(0x08001000, body));
    link.allowWrites = true;
    const steps = new Set<string>();
    await flashEsc(link, read, image, label => steps.add(label));
    expect([...steps]).toEqual(['Writing recovery marker', 'Writing firmware', 'Verifying']);
    expect(equal(bank.images[0].subarray(0x1000, 0x4000), body)).toBe(true);
    expect(equal(bank.images[0].subarray(0, 0x1000), bootloader)).toBe(true);
    const settings = bank.images[0].subarray(0x7c00, 0x7cb0);
    expect(new TextDecoder().decode(settings.subarray(5, 17))).toBe('NOT READY   ');
    expect(settings.subarray(0x11, 0x2d)).toEqual(read.block!.subarray(0x11, 0x2d));
  });

  it('refuse firmware that would overwrite the bootloader, or is not AM32', () => {
    expect(() => parseAm32Hex(hexFile(0x08000000, new Uint8Array(64)))).toThrow(/bootloader/);
    expect(() => parseAm32Hex(hexFile(0x08001000, new Uint8Array(64).fill(0xab)))).toThrow(/does not look like AM32/);
  });
});
