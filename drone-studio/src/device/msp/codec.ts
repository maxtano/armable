import { concat } from '../bytes';

/** MultiWii Serial Protocol, versions 1 and 2, as Betaflight and INAV speak it. */
export interface MspFrame { version: 1 | 2; direction: '<' | '>' | '!'; command: number; payload: Uint8Array }

export function crc8DvbS2(bytes: Uint8Array, crc = 0): number {
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}
export function encodeMsp(command: number, payload: Uint8Array = new Uint8Array(0), direction: '<' | '>' | '!' = '<'): Uint8Array {
  if (command > 254 || payload.length > 254) return encodeMspV2(command, payload, direction);
  let checksum = payload.length ^ command;
  for (const b of payload) checksum ^= b;
  return concat(Uint8Array.of(0x24, 0x4d, direction.charCodeAt(0), payload.length, command), payload, Uint8Array.of(checksum));
}
export function encodeMspV2(command: number, payload: Uint8Array = new Uint8Array(0), direction: '<' | '>' | '!' = '<'): Uint8Array {
  const body = concat(Uint8Array.of(0, command & 0xff, command >> 8, payload.length & 0xff, payload.length >> 8), payload);
  return concat(Uint8Array.of(0x24, 0x58, direction.charCodeAt(0)), body, Uint8Array.of(crc8DvbS2(body)));
}

export class MspParser {
  private buffer: Uint8Array = new Uint8Array(0);
  junk = 0;
  push(chunk: Uint8Array): MspFrame[] {
    let b = this.buffer.length ? concat(this.buffer, chunk) : chunk;
    if (b.length > 1 << 16) b = b.subarray(-8192);
    const out: MspFrame[] = [];
    for (;;) {
      let start = 0;
      while (start < b.length && b[start] !== 0x24) start++;
      this.junk += start;
      b = b.subarray(start);
      if (b.length < 3) break;
      const kind = b[1], dir = String.fromCharCode(b[2]);
      if ((kind !== 0x4d && kind !== 0x58) || !'<>!'.includes(dir)) { this.junk++; b = b.subarray(1); continue; }
      if (kind === 0x4d) {
        if (b.length < 6) break;
        const size = b[3], total = size + 6;
        if (b.length < total) break;
        let checksum = 0;
        for (let i = 3; i < total - 1; i++) checksum ^= b[i];
        if (checksum !== b[total - 1]) { this.junk++; b = b.subarray(1); continue; }
        out.push({ version: 1, direction: dir as MspFrame['direction'], command: b[4], payload: Uint8Array.from(b.subarray(5, total - 1)) });
        b = b.subarray(total);
      } else {
        if (b.length < 9) break;
        const size = b[6] | (b[7] << 8), total = size + 9;
        if (size > 8192) { this.junk++; b = b.subarray(1); continue; }
        if (b.length < total) break;
        if (crc8DvbS2(b.subarray(3, total - 1)) !== b[total - 1]) { this.junk++; b = b.subarray(1); continue; }
        out.push({ version: 2, direction: dir as MspFrame['direction'], command: b[4] | (b[5] << 8), payload: Uint8Array.from(b.subarray(8, total - 1)) });
        b = b.subarray(total);
      }
    }
    this.buffer = Uint8Array.from(b);
    return out;
  }
  reset() { this.buffer = new Uint8Array(0); }
}

/** Command numbers used by Armable. */
export const MSP = {
  API_VERSION: 1, FC_VARIANT: 2, FC_VERSION: 3, BOARD_INFO: 4, BUILD_INFO: 5, NAME: 10,
  BATTERY_CONFIG: 32, FEATURE_CONFIG: 36, MIXER_CONFIG: 42, RX_CONFIG: 44, REBOOT: 68,
  ADVANCED_CONFIG: 90, STATUS: 101, RAW_IMU: 102, MOTOR: 104, RC: 105, RAW_GPS: 106, ATTITUDE: 108,
  ALTITUDE: 109, ANALOG: 110, BOXNAMES: 116, BATTERY_STATE: 130, MOTOR_CONFIG: 131, MOTOR_TELEMETRY: 139,
  STATUS_EX: 150, UID: 160, DATAFLASH_SUMMARY: 70, DATAFLASH_READ: 71, DATAFLASH_ERASE: 72, ACC_CALIBRATION: 205, MAG_CALIBRATION: 206, SET_MOTOR: 214, SET_PASSTHROUGH: 245, EEPROM_WRITE: 250,
} as const;
