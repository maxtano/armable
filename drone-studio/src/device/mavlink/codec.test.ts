import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkProtocolV2, minimal, common, ardupilotmega, type MavLinkPacket } from 'node-mavlink';
import { encode, MavlinkParser, x25 } from './codec';
import { MESSAGES, type MessageName } from './messages';

const REG: Record<number, any> = { ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY };
const sample = (type: string, array: number, i: number): any => {
  if (type === 'char') return 'ABC_DEF'.slice(0, array || 1);
  const scalar = () => type === 'float' ? Math.fround(1.5 + i) : type.includes('64') ? BigInt(1000 + i) : type.startsWith('int') ? -(i + 1) : i + 1;
  return array ? Array.from({ length: array }, (_, k) => type === 'float' ? Math.fround(k + 0.25) : (k + 1) % 100) : scalar();
};

describe('MAVLink codec, checked against node-mavlink', () => {
  it('computes X25 like the reference', () => {
    expect(x25(new TextEncoder().encode('123456789'))).toBe(0x6f91);
  });

  for (const name of Object.keys(MESSAGES) as MessageName[]) {
    const def = MESSAGES[name];
    const clazz = REG[def.id];
    if (!clazz) continue;
    it(`${name}: our frame is read by node-mavlink, and theirs by ours`, async () => {
      const fields: Record<string, any> = {};
      def.fields.forEach(([field, type, , array], i) => { fields[field] = sample(type, array, i); });
      const frame = encode(name, fields, 7, 42, 1);

      // Ours -> theirs.
      const stream = new PassThrough();
      const reader = stream.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser());
      const got = new Promise<MavLinkPacket>(resolve => reader.once('data', resolve));
      stream.write(Buffer.from(frame));
      const packet = await got;
      expect(packet.header.msgid).toBe(def.id);
      const theirs = packet.protocol.data(packet.payload, clazz) as Record<string, any>;
      for (const f of clazz.FIELDS) {
        const mine = fields[f.source];
        const value = theirs[f.name];
        if (typeof mine === 'string') expect(value).toBe(mine);
        else if (Array.isArray(mine)) expect(Array.from(value as number[], Number)).toEqual(mine.map(Number));
        else expect(Number(value)).toBeCloseTo(Number(mine), 4);
      }

      // Theirs -> ours.
      const message = new clazz();
      for (const f of clazz.FIELDS) message[f.name] = fields[f.source];
      const bytes = new MavLinkProtocolV2(42, 1).serialize(message, 9);
      const [parsed] = new MavlinkParser().push(Uint8Array.from(bytes));
      expect(parsed?.name).toBe(name);
      expect(parsed.sysid).toBe(42);
      for (const [field, , , array] of def.fields) {
        const mine = fields[field], back = parsed.fields[field];
        if (typeof mine === 'string') expect(back).toBe(mine);
        else if (array) expect((back as number[]).map(Number)).toEqual((mine as number[]).map(Number));
        else expect(Number(back)).toBeCloseTo(Number(mine), 4);
      }
    });
  }

  it('resynchronises after noise, split chunks and a corrupted frame', () => {
    const a = encode('HEARTBEAT', { type: 2, autopilot: 3, base_mode: 81, custom_mode: 5, system_status: 3, mavlink_version: 3 }, 1, 1, 1);
    const bad = Uint8Array.from(a); bad[bad.length - 1] ^= 0xff;
    const b = encode('PARAM_VALUE', { param_id: 'ATC_RAT_RLL_P', param_value: 0.135, param_type: 9, param_count: 900, param_index: 12 }, 2, 1, 1);
    const stream = Uint8Array.from([1, 2, 3, ...bad, 0xfd, ...a, ...b]);
    const parser = new MavlinkParser();
    const packets = [...parser.push(stream.subarray(0, 11)), ...parser.push(stream.subarray(11, 40)), ...parser.push(stream.subarray(40))];
    expect(packets.map(p => p.name)).toEqual(['HEARTBEAT', 'PARAM_VALUE']);
    expect(packets[1].fields.param_id).toBe('ATC_RAT_RLL_P');
    expect(parser.junk).toBeGreaterThan(0);
  });

  it('reads MAVLink 1 frames', () => {
    const def = MESSAGES.HEARTBEAT;
    const payload = Uint8Array.of(5, 0, 0, 0, 2, 3, 81, 3, 3);
    const head = Uint8Array.of(0xfe, 9, 4, 1, 1, 0);
    const crc = x25(Uint8Array.of(def.crc), x25(Uint8Array.from([...head.subarray(1), ...payload])));
    const [p] = new MavlinkParser().push(Uint8Array.from([...head, ...payload, crc & 255, crc >> 8]));
    expect(p.fields).toMatchObject({ custom_mode: 5, type: 2, autopilot: 3 });
  });
});
