import { concat, DeviceError } from '../bytes';

export interface Segment { address: number; data: Uint8Array }
/** Intel HEX with extended addressing, as flight-controller firmware is distributed. Contiguous records are merged. */
export function parseIntelHex(text: string): Segment[] {
  const segments: Segment[] = [];
  let base = 0, ended = false, pending: { address: number; parts: Uint8Array[]; length: number } | undefined;
  const flush = () => { if (pending) segments.push({ address: pending.address, data: concat(...pending.parts) }); pending = undefined; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (ended || !/^:(?:[\da-fA-F]{2}){5,}$/.test(line)) throw new DeviceError('invalid', 'This is not a valid firmware HEX file.');
    const record = Uint8Array.from(line.slice(1).match(/../g)!, p => parseInt(p, 16));
    if (record.length !== record[0] + 5 || record.reduce((sum, x) => sum + x, 0) % 256) throw new DeviceError('invalid', 'Firmware HEX checksum failed.');
    const offset = (record[1] << 8) | record[2], type = record[3], data = record.subarray(4, 4 + record[0]);
    if (type === 0) {
      const address = base + offset;
      if (pending && pending.address + pending.length === address) { pending.parts.push(Uint8Array.from(data)); pending.length += data.length; }
      else { flush(); pending = { address, parts: [Uint8Array.from(data)], length: data.length }; }
    } else if (type === 1) ended = true;
    else if (type === 4) base = ((data[0] << 8) | data[1]) * 0x10000;
    else if (type === 2) base = ((data[0] << 8) | data[1]) * 16;
    else if (type !== 3 && type !== 5) throw new DeviceError('invalid', 'Unsupported firmware HEX record.');
  }
  flush();
  if (!ended || !segments.length) throw new DeviceError('invalid', 'Firmware HEX is incomplete.');
  return segments.sort((a, b) => a.address - b.address);
}
