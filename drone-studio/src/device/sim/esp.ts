import { concat, Writer, view } from '../bytes';
import { md5 } from '../flash/md5';
import { BLOCK, crc8DvbS2, espChecksum, SECTOR, SlipReader, slipEncode, type EspChip } from '../flash/esp';

/** An ESP chip in its ROM loader, speaking the esptool protocol. Flash behaves like flash: writes only clear bits. */
export class SimEspRom {
  flash: Uint8Array;
  started = false;
  synced = 0;
  eraseRequests: number[] = [];
  /** Corrupt one written byte, to prove the MD5 check catches it. */
  corruptAt?: number;
  private slip = new SlipReader();
  private writing?: { offset: number; blocks: number; size: number };
  constructor(readonly chip: EspChip = 'ESP8266', size = chip === 'ESP8266' ? 1 << 20 : 4 << 20) { this.flash = new Uint8Array(size).fill(0xff); }
  private status() { return this.chip === 'ESP8266' ? [0, 0] : [0, 0, 0, 0]; }
  private reply(op: number, value = 0, data: number[] = [], error = 0): Uint8Array {
    const status = error ? (this.chip === 'ESP8266' ? [1, error] : [1, error, 0, 0]) : this.status();
    const body = [...data, ...status];
    return slipEncode(concat(new Writer().u8(1).u8(op).u16(body.length).u32(value).done(), Uint8Array.from(body)));
  }
  handle(chunk: Uint8Array): Uint8Array {
    const out: Uint8Array[] = [];
    for (const f of this.slip.push(chunk)) {
      if (f.length < 8 || f[0] !== 0) continue;
      const op = f[1], dv = view(f), checksum = dv.getUint32(4, true), data = f.subarray(8);
      const u32 = (i: number) => view(data).getUint32(i, true);
      switch (op) {
        case 0x08: this.synced++; for (let i = 0; i < 8; i++) out.push(this.reply(op, 0x20120707)); break;
        case 0x0a: out.push(this.reply(op, u32(0) === 0x40001000 ? ({ ESP8266: 0xfff0c101, ESP32: 0x00f01d83 } as Record<string, number>)[this.chip] ?? 0x12345678 : 0)); break;
        case 0x14: {
          if (this.chip === 'ESP8266' || this.chip === 'ESP32') { out.push(this.reply(op, 0, [], 0x05)); break; }
          const id = { 'ESP32-C3': 5, 'ESP32-C6': 13, 'ESP32-S3': 9 }[this.chip as 'ESP32-C3'];
          out.push(this.reply(op, 0, [...new Writer().u32(0).u8(0).bytes([0, 0, 0, 0, 0, 0, 0]).u32(id).u32(0).done()])); break;
        }
        case 0x0d: out.push(this.reply(op)); break;
        case 0x02: {
          const erase = u32(0), blocks = u32(4), size = u32(8), offset = u32(12);
          this.eraseRequests.push(erase);
          // Real ESP8266 ROMs erase more than asked (esptool works around it); erase what will be written.
          const end = Math.min(this.flash.length, Math.ceil((offset + Math.max(erase, blocks * size)) / SECTOR) * SECTOR);
          this.flash.fill(0xff, offset, end);
          this.writing = { offset, blocks, size };
          out.push(this.reply(op)); break;
        }
        case 0x03: {
          const len = u32(0), seq = u32(4), block = data.subarray(16, 16 + len);
          if (!this.writing || len !== this.writing.size || espChecksum(block) !== checksum) { out.push(this.reply(op, 0, [], 0x07)); break; }
          const at = this.writing.offset + seq * BLOCK;
          block.forEach((b, i) => { this.flash[at + i] &= this.corruptAt === at + i ? b ^ 1 : b; });
          out.push(this.reply(op)); break;
        }
        case 0x13: {
          if (this.chip === 'ESP8266') { out.push(this.reply(op, 0, [], 0x05)); break; }
          const hash = md5(this.flash.subarray(u32(0), u32(0) + u32(4)));
          out.push(this.reply(op, 0, [...new TextEncoder().encode(hash)])); break;
        }
        case 0x04: this.started = true; out.push(this.reply(op)); break;
        default: out.push(this.reply(op, 0, [], 0x05));
      }
    }
    return concat(...out);
  }
}

/** An ExpressLRS receiver on a flight controller UART: CRSF commands reboot it into its ROM loader or into bind mode. */
export class ElrsReceiverSim {
  rom: SimEspRom;
  mode: 'app' | 'rom' = 'app';
  bindMode = false;
  private buffer: number[] = [];
  constructor(chip: EspChip = 'ESP8266', readonly target = 'BETAFPV_900_RX') { this.rom = new SimEspRom(chip); }
  handle(chunk: Uint8Array): Uint8Array {
    if (this.mode === 'rom') return this.rom.handle(chunk);
    this.buffer.push(...chunk);
    for (let i = 0; i + 5 < this.buffer.length; i++) {
      if (this.buffer[i] !== 0xec || this.buffer[i + 2] !== 0x32 || this.buffer[i + 3] !== 0x62) continue;
      // The length byte counts everything after it, including the checksum.
      const len = this.buffer[i + 1], crcAt = i + 1 + len;
      if (crcAt >= this.buffer.length) break;
      if (crc8DvbS2(this.buffer.slice(i + 2, crcAt)) !== this.buffer[crcAt]) continue;
      const kind = this.buffer[i + 4];
      this.buffer = this.buffer.slice(crcAt + 1);
      if (kind === 0x6c) { this.mode = 'rom'; return new TextEncoder().encode(`${this.target}\r\n`); }
      if (kind === 0x64) { this.bindMode = true; return new Uint8Array(0); }
    }
    return new Uint8Array(0);
  }
}
