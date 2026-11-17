import { concat, DeviceError, sleep, view, Writer } from '../bytes';
import type { ByteTransport } from '../transport';
import { md5 } from './md5';

/**
 * Espressif ROM serial loader, as used by esptool (esptool/loader.py): SLIP framing, SYNC, chip detection,
 * FLASH_BEGIN / FLASH_DATA / FLASH_END and, where the chip's ROM supports it, an MD5 check of what was written.
 * Used for ExpressLRS receivers and transmitters and ESP32 ground radios. No flasher stub is uploaded.
 */
export type EspChip = 'ESP8266' | 'ESP32' | 'ESP32-C3' | 'ESP32-C6' | 'ESP32-S3';
const OP = { FLASH_BEGIN: 0x02, FLASH_DATA: 0x03, FLASH_END: 0x04, SYNC: 0x08, READ_REG: 0x0a, SPI_ATTACH: 0x0d, SPI_FLASH_MD5: 0x13, GET_SECURITY_INFO: 0x14 } as const;
const MAGIC: Record<number, EspChip> = { 0xfff0c101: 'ESP8266', 0x00f01d83: 'ESP32' };
const CHIP_ID: Record<number, EspChip> = { 5: 'ESP32-C3', 13: 'ESP32-C6', 9: 'ESP32-S3' };
export const BLOCK = 0x400, SECTOR = 0x1000;
export const SYNC_FRAME = Uint8Array.from([0x07, 0x07, 0x12, 0x20, ...new Array(32).fill(0x55)]);

export function slipEncode(packet: Uint8Array): Uint8Array {
  const out = [0xc0];
  for (const b of packet) { if (b === 0xc0) out.push(0xdb, 0xdc); else if (b === 0xdb) out.push(0xdb, 0xdd); else out.push(b); }
  out.push(0xc0);
  return Uint8Array.from(out);
}
/** Splits a byte stream into SLIP frames. */
export class SlipReader {
  private frame: number[] | undefined;
  private escape = false;
  push(chunk: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (const b of chunk) {
      if (b === 0xc0) { if (this.frame?.length) out.push(Uint8Array.from(this.frame)); this.frame = []; this.escape = false; continue; }
      if (!this.frame) continue;
      if (this.escape) { this.frame.push(b === 0xdc ? 0xc0 : b === 0xdd ? 0xdb : b); this.escape = false; }
      else if (b === 0xdb) this.escape = true;
      else this.frame.push(b);
    }
    return out;
  }
}
export const espChecksum = (data: Uint8Array) => data.reduce((s, b) => s ^ b, 0xef);
/** ESP8266 ROM erase-size workaround (esptool ESP8266ROM.get_erase_size). */
export function esp8266EraseSize(offset: number, size: number): number {
  const perBlock = 16, sectors = Math.ceil(size / SECTOR), start = Math.floor(offset / SECTOR);
  let head = perBlock - (start % perBlock);
  if (sectors < head) head = sectors;
  return sectors < 2 * head ? Math.floor((sectors + 1) / 2) * SECTOR : (sectors - head) * SECTOR;
}

export class EspLoader {
  chip?: EspChip;
  private slip = new SlipReader();
  private frames: Uint8Array[] = [];
  private wake?: () => void;
  private off: () => void;
  constructor(private port: ByteTransport, private timing = { commandMs: 3000, eraseMsPerMb: 30_000, syncTries: 7 }) {
    this.off = port.onData(chunk => { for (const f of this.slip.push(chunk)) this.frames.push(f); this.wake?.(); });
  }
  dispose() { this.off(); }
  private async response(op: number, ms: number): Promise<{ value: number; data: Uint8Array }> {
    const end = Date.now() + ms;
    for (;;) {
      while (this.frames.length) {
        const f = this.frames.shift()!;
        if (f.length < 8 || f[0] !== 1 || f[1] !== op) continue;
        const dv = view(f);
        return { value: dv.getUint32(4, true), data: f.subarray(8) };
      }
      if (Date.now() > end) throw new DeviceError('timeout', 'The radio did not answer.', 'Check it is in its bootloader: hold BOOT while plugging in, or let Lucidity reset it.');
      await new Promise<void>(r => { const t = setTimeout(r, 20); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }
  private async command(op: number, data: Uint8Array = new Uint8Array(0), checksum = 0, ms = this.timing.commandMs, statusLength = 2) {
    const head = new Writer().u8(0).u8(op).u16(data.length).u32(checksum).done();
    await this.port.write(slipEncode(concat(head, data)));
    const r = await this.response(op, ms);
    const status = r.data.subarray(r.data.length - (r.data.length >= 4 && statusLength === 4 ? 4 : 2));
    if (status[0] !== 0) throw new DeviceError('rejected', `The radio's loader refused the request (error 0x${status[1].toString(16)}).`);
    return r;
  }
  /** Classic auto-reset into the bootloader, for boards that wire DTR and RTS to EN and IO0. */
  static async resetIntoBootloader(port: ByteTransport) {
    if (!port.setSignals) return false;
    await port.setSignals({ dtr: false, rts: true }); await sleep(100);
    await port.setSignals({ dtr: true, rts: false }); await sleep(50);
    await port.setSignals({ dtr: false, rts: false });
    return true;
  }
  async sync() {
    for (let i = 0; i < this.timing.syncTries; i++) {
      this.frames = [];
      try { await this.command(OP.SYNC, SYNC_FRAME, 0, 300); await sleep(30); this.frames = []; return; } catch { await sleep(50); }
    }
    throw new DeviceError('timeout', 'The radio did not respond to the bootloader handshake.', 'Put it in bootloader mode (hold BOOT while connecting) and try again.');
  }
  private status() { return this.chip === 'ESP8266' ? 2 : 4; }
  async detect(): Promise<EspChip> {
    const reg = new Writer().u32(0x40001000).done();
    const { value } = await this.command(OP.READ_REG, reg, 0, this.timing.commandMs, 2);
    let chip = MAGIC[value >>> 0];
    if (!chip) {
      const info = await this.command(OP.GET_SECURITY_INFO, new Uint8Array(0), 0, this.timing.commandMs, 4).catch(() => undefined);
      const id = info && info.data.length >= 20 ? view(info.data).getUint32(12, true) : undefined;
      chip = id === undefined ? undefined as unknown as EspChip : CHIP_ID[id];
    }
    if (!chip) throw new DeviceError('unsupported', 'This ESP chip is not supported yet.', 'Supported: ESP8266/ESP8285, ESP32, ESP32-C3, ESP32-C6, ESP32-S3.');
    this.chip = chip;
    if (chip !== 'ESP8266') await this.command(OP.SPI_ATTACH, new Uint8Array(8), 0, this.timing.commandMs, this.status());
    return chip;
  }
  /** Erase, write in 1 KB blocks, then check the MD5 where the ROM can compute it. */
  async flash(image: Uint8Array, offset: number, progress: (label: string, done?: number, total?: number) => void = () => {}): Promise<{ bytes: number; verified: boolean }> {
    if (!this.chip) throw new DeviceError('invalid', 'Detect the chip first.');
    if (offset % SECTOR) throw new DeviceError('invalid', 'The flash address must be a multiple of 4096.');
    const blocks = Math.ceil(image.length / BLOCK);
    const erase = this.chip === 'ESP8266' ? esp8266EraseSize(offset, image.length) : image.length;
    const begin = new Writer().u32(erase).u32(blocks).u32(BLOCK).u32(offset);
    if (this.chip !== 'ESP8266' && this.chip !== 'ESP32') begin.u32(0);
    progress('Erasing');
    await this.command(OP.FLASH_BEGIN, begin.done(), 0, Math.max(this.timing.commandMs, (image.length / 1_048_576) * this.timing.eraseMsPerMb + 3000), this.status());
    for (let seq = 0; seq < blocks; seq++) {
      const block = new Uint8Array(BLOCK).fill(0xff);
      block.set(image.subarray(seq * BLOCK, (seq + 1) * BLOCK));
      const head = new Writer().u32(BLOCK).u32(seq).u32(0).u32(0).done();
      let attempt = 0;
      for (;;) {
        try { await this.command(OP.FLASH_DATA, concat(head, block), espChecksum(block), this.timing.commandMs, this.status()); break; }
        catch (error) { if (++attempt >= 3) throw error; }
      }
      progress('Writing', Math.min((seq + 1) * BLOCK, image.length), image.length);
    }
    if (this.chip === 'ESP8266') return { bytes: image.length, verified: false };
    progress('Verifying');
    const req = new Writer().u32(offset).u32(image.length).u32(0).u32(0).done();
    const r = await this.command(OP.SPI_FLASH_MD5, req, 0, Math.max(this.timing.commandMs, 8000), 4);
    const got = new TextDecoder().decode(r.data.subarray(0, 32));
    if (got !== md5(image)) throw new DeviceError('mismatch', 'The radio holds different data from the file. Do not use it. Flash again.');
    return { bytes: image.length, verified: true };
  }
  /** Leave the loader and start the new firmware. */
  async finish() {
    const head = new Writer().u8(0).u8(OP.FLASH_END).u16(4).u32(0).done();
    await this.port.write(slipEncode(concat(head, Uint8Array.of(0, 0, 0, 0))));
    await this.response(OP.FLASH_END, 500).catch(() => undefined);
  }
}

/** A firmware file as given: raw .bin, checked for the ESP image header at the address it is meant for. */
export function checkEspImage(image: Uint8Array, offset: number, chip: EspChip): void {
  if (image.length < 256 || image.length > 16 * 1024 * 1024) throw new DeviceError('invalid', 'That file is not ESP firmware.');
  const header = (at: number) => image[at] === 0xe9;
  // A full image starts with the bootloader: at 0x1000 on the original ESP32, at 0 on the others.
  const ok = offset === 0 ? (chip === 'ESP32' ? header(0x1000) || header(0) : header(0)) : offset === 0x10000 ? header(0) : header(0);
  if (!ok) throw new DeviceError('mismatch', `This file does not start like ${chip} firmware for address 0x${offset.toString(16)}. Nothing was written.`, 'Use the firmware built for this exact receiver or radio, and the address its instructions give.');
}

// ---- ExpressLRS, through a Betaflight flight controller ---------------------------------------------------------------

export function crc8DvbS2(bytes: number[]): number {
  let crc = 0;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff; }
  return crc;
}
/** ExpressLRS's own command frames (src/python/bootloader.py): reboot into the ROM loader, or enter bind mode. */
export function elrsCommand(kind: 'bootloader' | 'bind', key = ''): Uint8Array {
  const payload = [0xec, 0x04 + key.length, 0x32, ...(kind === 'bootloader' ? [0x62, 0x6c] : [0x62, 0x64]), ...[...key].map(c => c.charCodeAt(0))];
  return Uint8Array.from([...payload, crc8DvbS2(payload.slice(2))]);
}

/** Flash a radio or receiver plugged in directly over USB: reset into the loader, check the file, write, verify, restart. */
export async function flashEspDevice(port: ByteTransport, image: Uint8Array, offset: number, progress: (label: string, done?: number, total?: number) => void = () => {}, timing?: ConstructorParameters<typeof EspLoader>[1]) {
  const loader = new EspLoader(port, timing);
  try {
    progress('Connecting');
    await EspLoader.resetIntoBootloader(port);
    await loader.sync();
    const chip = await loader.detect();
    checkEspImage(image, offset, chip);
    const result = await loader.flash(image, offset, progress);
    await loader.finish();
    return { chip, ...result };
  } finally { loader.dispose(); }
}
