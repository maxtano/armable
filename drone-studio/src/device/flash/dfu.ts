import { DeviceError, equal, sleep } from '../bytes';
import type { Segment } from './hex';

/**
 * STM32 DfuSe firmware download, as Betaflight flight controllers use in bootloader mode.
 * Written from ST's AN3156 and the DFU 1.1 specification. Exercised against a simulated bootloader only;
 * it has not been run on hardware.
 */
export interface DfuPort {
  /** Memory layout string from the interface name, e.g. "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg". */
  readonly layout: string;
  readonly transferSize: number;
  out(request: number, value: number, data?: Uint8Array): Promise<void>;
  in(request: number, value: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
const DNLOAD = 1, UPLOAD = 2, GETSTATUS = 3, CLRSTATUS = 4, ABORT = 6;
const STATE = { idle: 2, dnloadIdle: 5, manifest: 7, uploadIdle: 9, error: 10 } as const;

export interface Sector { address: number; size: number }
export function parseLayout(layout: string): Sector[] {
  const m = layout.match(/\/0x([\da-fA-F]+)\/(.+)$/);
  if (!m) throw new DeviceError('unsupported', 'The bootloader did not describe its flash memory.');
  let address = parseInt(m[1], 16);
  const sectors: Sector[] = [];
  for (const part of m[2].split(',')) {
    const p = part.trim().match(/^(\d+)\*(\d+)([KMB ])[a-g]$/);
    if (!p) throw new DeviceError('unsupported', 'The bootloader described its flash memory in an unknown way.');
    const size = Number(p[2]) * (p[3] === 'K' ? 1024 : p[3] === 'M' ? 1024 * 1024 : 1);
    for (let i = 0; i < Number(p[1]); i++) { sectors.push({ address, size }); address += size; }
  }
  return sectors;
}
async function status(port: DfuPort) {
  const s = await port.in(GETSTATUS, 0, 6);
  return { status: s[0], pollMs: s[1] | (s[2] << 8) | (s[3] << 16), state: s[4] };
}
async function settle(port: DfuPort, wanted: number, what: string) {
  for (let i = 0; i < 200; i++) {
    const s = await status(port);
    if (s.state === wanted) return;
    if (s.state === STATE.error) { await port.out(CLRSTATUS, 0); throw new DeviceError('rejected', `The bootloader reported an error while ${what} (status ${s.status}).`); }
    await sleep(Math.min(s.pollMs, 2000));
  }
  throw new DeviceError('timeout', `The bootloader did not finish ${what}.`);
}
async function command(port: DfuPort, code: number, address: number, what: string) {
  await port.out(DNLOAD, 0, Uint8Array.of(code, address & 255, (address >>> 8) & 255, (address >>> 16) & 255, (address >>> 24) & 255));
  await settle(port, STATE.dnloadIdle, what);
}
async function toIdle(port: DfuPort) {
  const s = await status(port);
  if (s.state === STATE.error) await port.out(CLRSTATUS, 0);
  else if (s.state !== STATE.idle) await port.out(ABORT, 0);
}

/** Erase the sectors the image touches, write it, read it back, then start it. */
export async function dfuFlash(port: DfuPort, segments: Segment[], progress: (label: string, done?: number, total?: number) => void = () => {}): Promise<{ bytes: number; sectors: number }> {
  const sectors = parseLayout(port.layout);
  const start = sectors[0].address, end = sectors.at(-1)!.address + sectors.at(-1)!.size;
  for (const s of segments) if (s.address < start || s.address + s.data.length > end)
    throw new DeviceError('mismatch', 'This firmware does not fit the flight controller\'s memory. It is probably built for a different board. Nothing was written.');
  const touched = sectors.filter(sec => segments.some(s => s.address < sec.address + sec.size && s.address + s.data.length > sec.address));
  const total = segments.reduce((n, s) => n + s.data.length, 0), size = port.transferSize;
  await toIdle(port);
  for (const [i, sector] of touched.entries()) { progress('Erasing', i, touched.length); await command(port, 0x41, sector.address, 'erasing'); }
  let done = 0;
  for (const segment of segments) {
    for (let offset = 0; offset < segment.data.length; offset += size) {
      const chunk = segment.data.subarray(offset, offset + size);
      await command(port, 0x21, segment.address + offset, 'setting the address');
      await port.out(DNLOAD, 2, chunk);
      await settle(port, STATE.dnloadIdle, 'writing');
      done += chunk.length;
      progress('Writing', done, total);
    }
  }
  done = 0;
  for (const segment of segments) {
    for (let offset = 0; offset < segment.data.length; offset += size) {
      const chunk = segment.data.subarray(offset, offset + size);
      await command(port, 0x21, segment.address + offset, 'setting the address');
      await port.out(ABORT, 0);
      const back = await port.in(UPLOAD, 2, chunk.length);
      await port.out(ABORT, 0);
      if (!equal(back, chunk)) throw new DeviceError('mismatch', `Readback did not match at 0x${(segment.address + offset).toString(16)}. Do not fly. Flash again.`);
      done += chunk.length;
      progress('Verifying', done, total);
    }
  }
  progress('Starting the new firmware');
  await command(port, 0x21, segments[0].address, 'setting the start address');
  await port.out(DNLOAD, 0, new Uint8Array(0));
  await status(port).catch(() => {});
  return { bytes: total, sectors: touched.length };
}

/** WebUSB adapter. `device` must be an STM32 in DFU mode (0483:df11), chosen by the person. */
export async function openWebUsbDfu(device: USBDevice): Promise<DfuPort> {
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const found = device.configuration!.interfaces.flatMap(i => i.alternates.map(a => ({ i, a }))).find(({ a }) => a.interfaceClass === 0xfe && a.interfaceSubclass === 1 && /Internal Flash/i.test(a.interfaceName ?? ''));
  if (!found) throw new DeviceError('unsupported', 'That USB device is not a flight controller in firmware-update mode.');
  const iface = found.i.interfaceNumber;
  await device.claimInterface(iface);
  await device.selectAlternateInterface(iface, found.a.alternateSetting);
  const setup = (request: number, value: number): USBControlTransferParameters => ({ requestType: 'class', recipient: 'interface', request, value, index: iface });
  return {
    layout: found.a.interfaceName!, transferSize: 2048,
    async out(request, value, data) { const r = await device.controlTransferOut(setup(request, value), data ? Uint8Array.from(data) : undefined); if (r.status !== 'ok') throw new DeviceError('rejected', 'USB transfer failed.'); },
    async in(request, value, length) { const r = await device.controlTransferIn(setup(request, value), length); if (r.status !== 'ok' || !r.data) throw new DeviceError('rejected', 'USB transfer failed.'); return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength); },
    async close() { await device.close().catch(() => {}); },
  };
}

/** A simulated STM32 bootloader, for tests. Flash behaves like flash: a write only clears bits. */
export class SimDfu implements DfuPort {
  layout = '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,03*128Kg';
  transferSize = 2048;
  memory = new Uint8Array(16384 * 4 + 65536 + 131072 * 3).fill(0);
  erased: number[] = [];
  started = false;
  /** Corrupt one byte on write, to prove verification catches it. */
  corruptAt?: number;
  private pointer = 0x08000000;
  private state: number = STATE.idle;
  private busy = false;
  async out(request: number, value: number, data?: Uint8Array) {
    if (request === ABORT || request === CLRSTATUS) { this.state = STATE.idle; return; }
    if (request !== DNLOAD) throw new Error('unexpected request');
    if (value === 0 && data?.length === 5) {
      const address = (data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24)) >>> 0;
      if (data[0] === 0x21) this.pointer = address;
      else if (data[0] === 0x41) {
        const sector = parseLayout(this.layout).find(s => s.address === address);
        if (!sector) { this.state = STATE.error; return; }
        this.memory.fill(255, address - 0x08000000, address - 0x08000000 + sector.size); this.erased.push(address);
      }
    } else if (value === 0 && !data?.length) { this.started = true; this.state = STATE.manifest; return; }
    else if (value >= 2 && data) {
      const at = this.pointer - 0x08000000 + (value - 2) * this.transferSize;
      data.forEach((b, i) => { this.memory[at + i] &= this.corruptAt === at + i ? b ^ 1 : b; });
    }
    this.busy = true; this.state = STATE.dnloadIdle;
  }
  async in(request: number, value: number, length: number) {
    if (request === GETSTATUS) { const state = this.busy ? 4 : this.state; this.busy = false; return Uint8Array.of(0, 1, 0, 0, state, 0); }
    if (request === UPLOAD) { const at = this.pointer - 0x08000000 + (value - 2) * this.transferSize; this.state = STATE.uploadIdle; return this.memory.slice(at, at + length); }
    throw new Error('unexpected request');
  }
  async close() {}
}
