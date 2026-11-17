import { concat, fromAscii } from '../bytes';
import { BB2, crc16 } from '../esc/fourway';
import { encodeMsp, MspParser } from '../msp/codec';

/** A bank of simulated EFM8 BB2 ESCs behind a flight controller's passthrough. Flash behaves like flash: writes only clear bits. */
export function escImage(firmware: 'BLHeli_S' | 'Bluejay', direction = 1): Uint8Array {
  const image = new Uint8Array(BB2.size).fill(255);
  image.set([0x02, 0x00, 0x80], 0);
  const s = new Uint8Array(BB2.page).fill(255);
  s.fill(0, 0, 0x70);
  if (firmware === 'Bluejay') { s[0] = 0; s[1] = 21; s[2] = 208; s.set(fromAscii('Bluejay (.0)', 16).map(b => b || 0x20), 0x60); s[0x0a] = 24; }
  else { s[0] = 16; s[1] = 7; s[2] = 33; }
  s[0x0b] = direction; s[0x0d] = 0x55; s[0x0e] = 0xaa; s[0x15] = 3; s[0x1b] = 40; s[0x1c] = 80; s[0x1d] = 4; s[0x1f] = 2; s[0x23] = 7; s[0x27] = 0;
  s.set(fromAscii('#J_H_40#', 16).map(b => b || 0x20), 0x40);
  s.set(fromAscii('#BLHELI$EFM8B21#', 16), 0x50);
  if (firmware === 'BLHeli_S') s.fill(0, 0x60, 0x70);
  image.set(s, BB2.settings);
  image.set([0x02, 0x1c, 0x03], BB2.bootloader);
  return image;
}

export class EscBank {
  images: Uint8Array[];
  selected = -1;
  active = false;
  /** Count of four-way commands seen, by command byte. */
  seen: Record<number, number> = {};
  /** Make the next N responses a negative acknowledgement. */
  nackNext = 0;
  private msp = new MspParser();
  private buffer = new Uint8Array(0);
  constructor(readonly variant: string, firmwares: ('BLHeli_S' | 'Bluejay')[] = ['Bluejay', 'Bluejay', 'Bluejay', 'Bluejay'], directions: number[] = [1, 1, 2, 1]) {
    this.images = firmwares.map((f, i) => escImage(f, directions[i] ?? 1));
  }
  /** Feed host bytes. Returns the bytes to send back, or null if they were not for the ESC interface. */
  handle(chunk: Uint8Array): Uint8Array | null {
    const replies: Uint8Array[] = [];
    let consumed = false;
    for (const frame of this.msp.push(chunk)) {
      if (frame.direction !== '<') continue;
      consumed = true;
      if (frame.command === 1) replies.push(encodeMsp(1, Uint8Array.of(0, 1, 46), '>'));
      else if (frame.command === 2) replies.push(encodeMsp(2, fromAscii(this.variant, 4), '>'));
      else if (frame.command === 245) { this.active = true; replies.push(encodeMsp(245, Uint8Array.of(this.images.length), '>')); }
    }
    if (this.active) {
      this.buffer = concat(this.buffer, chunk);
      for (;;) {
        const at = this.buffer.indexOf(0x2f);
        if (at < 0) { this.buffer = new Uint8Array(0); break; }
        const b = this.buffer.subarray(at);
        if (b.length < 5) { this.buffer = b; break; }
        const size = b[4] || 256, total = size + 7;
        if (b.length < total) { this.buffer = b; break; }
        if (crc16(b.subarray(0, total - 2)) !== ((b[total - 2] << 8) | b[total - 1])) { this.buffer = b.subarray(1); continue; }
        this.buffer = b.subarray(total);
        consumed = true;
        replies.push(this.four(b[1], (b[2] << 8) | b[3], b.subarray(5, 5 + size)));
      }
    }
    return consumed ? concat(...replies) : null;
  }
  private reply(command: number, address: number, payload: Uint8Array, ack = 0) {
    const body = concat(Uint8Array.of(0x2e, command, address >> 8, address & 255, payload.length & 255), payload, Uint8Array.of(ack));
    const crc = crc16(body);
    return concat(body, Uint8Array.of(crc >> 8, crc & 255));
  }
  private four(command: number, address: number, params: Uint8Array): Uint8Array {
    this.seen[command] = (this.seen[command] ?? 0) + 1;
    if (this.nackNext > 0) { this.nackNext--; return this.reply(command, address, Uint8Array.of(0), 0x0f); }
    const image = this.images[this.selected];
    switch (command) {
      case 0x37: {
        if (params[0] >= this.images.length) return this.reply(command, address, Uint8Array.of(0, 0, 0, 0), 0x0f);
        this.selected = params[0];
        return this.reply(command, address, Uint8Array.of(0xb2, 0xe8, 0x64, 1));
      }
      case 0x3a: {
        const length = params[0] || 256;
        if (!image) return this.reply(command, address, Uint8Array.of(0), 0x0f);
        return this.reply(command, address, image.slice(address, address + length));
      }
      case 0x39: {
        if (!image) return this.reply(command, address, Uint8Array.of(0), 0x0f);
        image.fill(255, params[0] * BB2.page, (params[0] + 1) * BB2.page);
        return this.reply(command, address, Uint8Array.of(0));
      }
      case 0x3b: {
        if (!image || address + params.length > BB2.bootloader) return this.reply(command, address, Uint8Array.of(0), 0x0f);
        params.forEach((byte, i) => { image[address + i] &= byte; });
        return this.reply(command, address, Uint8Array.of(0));
      }
      case 0x35: this.selected = -1; return this.reply(command, address, Uint8Array.of(0));
      case 0x34: this.active = false; this.selected = -1; return this.reply(command, address, Uint8Array.of(0));
      default: return this.reply(command, address, Uint8Array.of(0), 0x02);
    }
  }
}
