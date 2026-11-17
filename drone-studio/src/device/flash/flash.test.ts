import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { loopback } from '../transport';
import { dfuFlash, parseLayout, SimDfu } from './dfu';
import { parseIntelHex } from './hex';
import { bootloaderCrc, parseApj, px4Flash, SimBootloader } from './px4';

function hexFile(address: number, data: Uint8Array): string {
  const rec = (offset: number, type: number, bytes: number[]) => { const b = [bytes.length, offset >> 8, offset & 255, type, ...bytes]; return ':' + [...b, (256 - (b.reduce((s, x) => s + x, 0) % 256)) % 256].map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(''); };
  const lines = [rec(0, 4, [address >>> 24, (address >>> 16) & 255])];
  for (let at = 0; at < data.length; at += 16) lines.push(rec((address & 0xffff) + at, 0, [...data.subarray(at, at + 16)]));
  return [...lines, rec(0, 1, [])].join('\n');
}
const image = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 255);

describe('firmware files', () => {
  it('reads Intel HEX with extended addresses and merges contiguous records', () => {
    const [segment, ...rest] = parseIntelHex(hexFile(0x08000000, image(100)));
    expect(rest).toHaveLength(0);
    expect(segment.address).toBe(0x08000000);
    expect([...segment.data]).toEqual([...image(100)]);
  });
  it('rejects a corrupted or truncated HEX file', () => {
    const good = hexFile(0x08000000, image(32));
    expect(() => parseIntelHex(good.replace(/.$/m, c => c === '0' ? '1' : '0'))).toThrow(/checksum|valid/);
    expect(() => parseIntelHex(good.split('\n').slice(0, -1).join('\n'))).toThrow(/incomplete/);
    expect(() => parseIntelHex('hello')).toThrow(/valid/);
  });
});

describe('STM32 DFU flashing against a simulated bootloader', () => {
  it('reads the memory layout', () => {
    const sectors = parseLayout('@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg');
    expect(sectors).toHaveLength(12);
    expect(sectors[4]).toEqual({ address: 0x08010000, size: 65536 });
  });
  it('erases only the sectors it needs, writes, verifies and starts the firmware', async () => {
    const dfu = new SimDfu();
    const data = image(20000);
    const steps = new Set<string>();
    const result = await dfuFlash(dfu, parseIntelHex(hexFile(0x08000000, data)), label => steps.add(label));
    expect(result).toEqual({ bytes: 20000, sectors: 2 });
    expect(dfu.erased).toEqual([0x08000000, 0x08004000]);
    expect([...dfu.memory.subarray(0, 20000)]).toEqual([...data]);
    expect(dfu.memory[40000]).toBe(0);
    expect(dfu.started).toBe(true);
    expect([...steps]).toEqual(['Erasing', 'Writing', 'Verifying', 'Starting the new firmware']);
  });
  it('catches a byte that did not write correctly and does not start the firmware', async () => {
    const dfu = new SimDfu();
    dfu.corruptAt = 5000;
    await expect(dfuFlash(dfu, parseIntelHex(hexFile(0x08000000, image(8000))))).rejects.toMatchObject({ code: 'mismatch' });
    expect(dfu.started).toBe(false);
  });
  it('refuses firmware that does not fit this board, before erasing anything', async () => {
    const dfu = new SimDfu();
    await expect(dfuFlash(dfu, parseIntelHex(hexFile(0x24000000, image(64))))).rejects.toMatchObject({ code: 'mismatch' });
    expect(dfu.erased).toEqual([]);
  });
});

describe('ArduPilot / PX4 bootloader flashing against a simulated bootloader', () => {
  const apj = (boardId: number, data: Uint8Array) => new TextEncoder().encode(JSON.stringify({ board_id: boardId, image_size: data.length, image: Buffer.from(deflateSync(data)).toString('base64'), summary: 'TestBoard' }));
  it('unpacks a firmware file', async () => {
    const fw = await parseApj(apj(1013, image(1001)));
    expect(fw.boardId).toBe(1013);
    expect(fw.image.length).toBe(1004);
    expect([...fw.image.subarray(0, 1001)]).toEqual([...image(1001)]);
    await expect(parseApj(new TextEncoder().encode('not json'))).rejects.toMatchObject({ code: 'invalid' });
  });
  it('matches the reference checksum for a known input', () => {
    // CRC-32 with a zero start value and no final inversion gives 0x2DFD2D88 for "123456789".
    expect(bootloaderCrc(new TextEncoder().encode('123456789'), 9)).toBe(0x2dfd2d88);
    // Padding to the flash size is counted as 0xFF bytes.
    expect(bootloaderCrc(Uint8Array.of(1, 2), 4)).toBe(bootloaderCrc(Uint8Array.of(1, 2, 255, 255), 4));
  });
  it('checks the board, erases, writes, verifies and restarts', async () => {
    const [host, device] = loopback();
    const boot = new SimBootloader(device);
    const fw = await parseApj(apj(1013, image(1500)));
    const result = await px4Flash(host, fw, () => {}, { syncMs: 200, eraseMs: 500 });
    expect(result).toEqual({ boardId: 1013, bytes: 1500 });
    expect([...boot.flash.subarray(0, 1500)]).toEqual([...image(1500)]);
    expect(boot.rebooted).toBe(true);
  });
  it('refuses firmware built for another board before erasing', async () => {
    const [host, device] = loopback();
    const boot = new SimBootloader(device, 9);
    await expect(px4Flash(host, await parseApj(apj(1013, image(64))), () => {}, { syncMs: 200, eraseMs: 500 })).rejects.toMatchObject({ code: 'mismatch' });
    expect(boot.erased).toBe(false);
  });
  it('reports clearly when no bootloader answers', async () => {
    const [host] = loopback();
    await expect(px4Flash(host, await parseApj(apj(1, image(8))), () => {}, { syncMs: 20, eraseMs: 50 })).rejects.toMatchObject({ code: 'timeout' });
  });
});
