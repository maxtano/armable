import { ascii, DeviceError, equal } from '../bytes';
import { parseIntelHex } from '../flash/hex';
import type { EscInfo, Setting } from '../types';
import type { EscRead, FourWay } from './fourway';

/**
 * AM32 ESCs on ARM chips, through the same four-way passthrough. Layout and procedure follow ESC Configurator
 * (src/sources/AM32/eeprom.js, src/utils/Hardware/Arm.js, src/utils/FourWay.js): settings are a 0xB0-byte block,
 * written without a separate erase because the ARM bootloader erases a page when a write starts it.
 */
export const ARM_MODE = 4;
export const ARM_MCUS: Record<number, { name: string; settings: number }> = { 0x1f06: { name: 'STM32F051', settings: 0x7c00 }, 0x3506: { name: 'ARM64K', settings: 0xf800 } };
export const AM32 = { layoutSize: 0xb0, page: 1024, firmwareStart: 0x1000, flashSize: 0x10000 } as const;

interface Field { key: string; offset: number; title: string; description: string; options?: [number, string][]; min?: number; max?: number; unit?: string; toValue?: (b: number) => number; toByte?: (v: number) => number }
const onOff: [number, string][] = [[0, 'Off'], [1, 'On']];
export const AM32_FIELDS: Field[] = [
  { key: 'direction', offset: 0x11, title: 'Direction', description: 'Which way the motor turns.', options: [[0, 'Normal'], [1, 'Reversed']] },
  { key: 'bidirectional', offset: 0x12, title: 'Bidirectional (3D)', description: 'Lets the motor turn both ways from the throttle.', options: onOff },
  { key: 'sine_startup', offset: 0x13, title: 'Sine start', description: 'Smoother, quieter low-speed start.', options: onOff },
  { key: 'complementary_pwm', offset: 0x14, title: 'Complementary PWM', description: 'Active freewheeling; usually on.', options: onOff },
  { key: 'variable_pwm', offset: 0x15, title: 'Variable PWM frequency', description: 'PWM frequency follows motor speed.', options: onOff },
  { key: 'stuck_rotor_protection', offset: 0x16, title: 'Stuck rotor protection', description: 'Cuts power if the rotor is blocked.', options: onOff },
  { key: 'timing', offset: 0x17, title: 'Motor timing', description: 'Commutation timing advance.', options: [[0, '0°'], [1, '7.5°'], [2, '15°'], [3, '22.5°']] },
  { key: 'pwm_frequency', offset: 0x18, title: 'PWM frequency', description: 'Motor drive frequency.', min: 8, max: 48, unit: 'kHz' },
  { key: 'startup_power', offset: 0x19, title: 'Startup power', description: 'Power used to start the motor.', min: 50, max: 150, unit: '%' },
  { key: 'motor_kv', offset: 0x1a, title: 'Motor KV', description: 'Motor speed constant.', min: 20, max: 10220, unit: 'KV', toValue: b => b * 40 + 20, toByte: v => Math.round((v - 20) / 40) },
  { key: 'motor_poles', offset: 0x1b, title: 'Motor poles', description: 'Magnet poles in the motor bell.', min: 2, max: 36 },
  { key: 'brake_on_stop', offset: 0x1c, title: 'Brake on stop', description: 'Brake the motor at zero throttle.', options: onOff },
  { key: 'stall_protection', offset: 0x1d, title: 'Stall protection', description: 'Extra power near stall.', options: onOff },
  { key: 'beep_strength', offset: 0x1e, title: 'Beep volume', description: 'Volume of startup and signal beeps.', min: 0, max: 11 },
  { key: 'low_voltage_cutoff', offset: 0x24, title: 'Low voltage cutoff', description: 'Reduce power when the battery is low.', options: onOff },
  { key: 'low_voltage_threshold', offset: 0x25, title: 'Cutoff voltage', description: 'Per cell.', min: 2.5, max: 3.5, unit: 'V', toValue: b => (b + 250) / 100, toByte: v => Math.round(v * 100 - 250) },
  { key: 'temperature_limit', offset: 0x2b, title: 'Temperature limit', description: 'Reduce power above this temperature. 141 or more is off.', min: 70, max: 141, unit: '°C' },
  { key: 'current_limit', offset: 0x2c, title: 'Current limit', description: 'Maximum current. 102 or more is off.', min: 0, max: 102, unit: 'A', toValue: b => b * 2, toByte: v => Math.round(v / 2) },
];

export function describeAm32(index: number, signature: number, block: Uint8Array, at: number): EscInfo {
  const mcu = ARM_MCUS[signature];
  const name = ascii(block.subarray(0x05, 0x11)).trim();
  const layout = block[0x01];
  const valid = block[0x00] === 0x01 && layout >= 1 && layout <= 3 && /^[\x20-\x7e]*$/.test(name);
  return { index, at, firmware: valid ? 'AM32' : 'Unknown', version: valid ? `${block[0x03]}.${block[0x04]}` : undefined, layout: name || undefined,
    mcu: mcu?.name, signature: `0x${signature.toString(16).toUpperCase()}`, interfaceMode: ARM_MODE, writable: valid && !!mcu,
    error: valid ? undefined : 'The ESC answered, but its settings are not a known AM32 layout.' };
}
export async function readAm32(link: FourWay, index0: number, signature: number, now: () => number): Promise<EscRead> {
  const mcu = ARM_MCUS[signature];
  if (!mcu) return { info: { index: index0 + 1, at: now(), firmware: 'Unknown', writable: false, signature: `0x${signature.toString(16).toUpperCase()}`, interfaceMode: ARM_MODE, error: 'This ARM ESC chip is not known yet.' } };
  const block = await link.read(mcu.settings, AM32.layoutSize);
  return { info: describeAm32(index0 + 1, signature, block, now()), address: mcu.settings, block };
}
export function am32Settings(info: EscInfo, block: Uint8Array): Setting[] {
  return AM32_FIELDS.map(f => {
    const raw = block[f.offset];
    return {
      id: `esc.${info.index}.${f.key}`, name: f.key, part: 'motors' as const, group: `ESC ${info.index}`, title: `ESC ${info.index} ${f.title.toLowerCase()}`, description: f.description,
      value: f.options ? (f.options.find(o => o[0] === raw)?.[1].toLowerCase() ?? raw) : (f.toValue ? f.toValue(raw) : raw),
      type: f.options ? 'enum' as const : 'number' as const, options: f.options?.map(([, label]) => ({ value: label.toLowerCase(), label })),
      min: f.min, max: f.max, unit: f.unit, step: f.key === 'low_voltage_threshold' ? 0.01 : f.key === 'motor_kv' ? 40 : f.key === 'current_limit' ? 2 : 1, readOnly: !info.writable, at: info.at,
    };
  });
}
export function encodeAm32Field(key: string, value: string | number): { offset: number; byte: number } {
  const f = AM32_FIELDS.find(x => x.key === key);
  if (!f) throw new DeviceError('unsupported', `ESC setting "${key}" does not exist on AM32.`, `AM32 settings: ${AM32_FIELDS.map(x => x.key).join(', ')}.`);
  if (f.options) {
    const hit = f.options.find(([n, label]) => label.toLowerCase() === String(value).toLowerCase() || n === value);
    if (!hit) throw new DeviceError('invalid', `"${value}" is not allowed.`, `Use one of: ${f.options.map(o => o[1].toLowerCase()).join(', ')}.`);
    return { offset: f.offset, byte: hit[0] };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < f.min! || n > f.max!) throw new DeviceError('invalid', `${f.title} must be from ${f.min} to ${f.max}${f.unit ? ` ${f.unit}` : ''}.`);
  const byte = f.toByte ? f.toByte(n) : Math.round(n);
  if (byte < 0 || byte > 255) throw new DeviceError('invalid', `${f.title} is out of range.`);
  return { offset: f.offset, byte };
}
/** Patch the settings block and read it back. Everything but the patched bytes is written back as it was read. */
export async function patchAm32(link: FourWay, read: EscRead, patches: { offset: number; byte: number }[]): Promise<Uint8Array> {
  if (!read.info.writable || !read.block || read.address === undefined) throw new DeviceError('unsupported', 'This ESC cannot be changed by Lucidity yet.');
  const before = await link.read(read.address, AM32.layoutSize);
  if (!equal(before, read.block)) throw new DeviceError('stale', 'The ESC settings changed since they were read. Read the ESCs again.');
  const next = Uint8Array.from(before);
  for (const { offset, byte } of patches) {
    if (offset < 0x11 || offset >= AM32.layoutSize) throw new DeviceError('invalid', 'That is not an AM32 setting.');
    next[offset] = byte;
  }
  if (equal(before, next)) return before;
  await link.writeArm(read.address, next);
  const after = await link.read(read.address, AM32.layoutSize);
  if (!equal(after, next)) throw new DeviceError('mismatch', 'The ESC did not keep the new settings. Read it again before flying.');
  return after;
}
/** AM32 firmware is Intel HEX for 0x08001000 upward. Returns a 64 KB image indexed from the start of flash. */
export function parseAm32Hex(text: string): Uint8Array {
  const image = new Uint8Array(AM32.flashSize).fill(0xff);
  let top = 0;
  for (const s of parseIntelHex(text)) {
    const at = s.address - 0x08000000;
    if (at < AM32.firmwareStart || at + s.data.length > AM32.flashSize) throw new DeviceError('invalid', 'This firmware would overwrite the ESC bootloader or does not fit. Nothing was written.');
    image.set(s.data, at); top = Math.max(top, at + s.data.length);
  }
  const stack = image[0x1000] | (image[0x1001] << 8) | (image[0x1002] << 16) | (image[0x1003] << 24);
  if ((stack >>> 0) >>> 24 !== 0x20) throw new DeviceError('invalid', 'This file does not look like AM32 firmware.');
  return image.subarray(0, Math.ceil(top / 256) * 256);
}
export async function flashAm32(link: FourWay, read: EscRead, image: Uint8Array, progress: (label: string, done?: number, total?: number) => void): Promise<void> {
  if (!read.info.writable || !read.block || read.address === undefined) throw new DeviceError('unsupported', 'This ESC cannot be flashed by Lucidity yet.');
  const settings = Uint8Array.from(read.block);
  const marker = new Uint8Array(17);
  marker.set([settings[1], settings[2]], 1);
  marker.set(new TextEncoder().encode('FLASH FAIL  '), 5);
  progress('Writing recovery marker');
  await link.writeArm(read.address, marker);
  for (let at = AM32.firmwareStart; at < image.length; at += 256) {
    await link.writeArm(at, image.subarray(at, Math.min(at + 256, image.length)));
    progress('Writing firmware', at - AM32.firmwareStart, image.length - AM32.firmwareStart);
  }
  for (let at = AM32.firmwareStart; at < image.length; at += 128) {
    if (at <= read.address && read.address < at + 128) continue; // The settings block is restored below.
    const part = image.subarray(at, Math.min(at + 128, image.length));
    if (!equal(await link.read(at, part.length), part)) throw new DeviceError('mismatch', `Firmware readback did not match at 0x${at.toString(16)}. Do not fly. Flash again.`);
    progress('Verifying', at - AM32.firmwareStart, image.length - AM32.firmwareStart);
  }
  // Keep the person's settings; the firmware fills in its own name and version when it next starts.
  settings[0] = 0x01; settings.fill(0, 3, 5); settings.set(new TextEncoder().encode('NOT READY   '), 5);
  await link.writeArm(read.address, settings);
}
