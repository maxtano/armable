/**
 * A blackbox writer, for the simulator and tests. It mirrors Betaflight's blackbox.c encodings so the decoder can
 * be checked end to end. Not used in the product.
 */
export class BitWriter {
  bytes: number[] = [];
  byte(v: number) { this.bytes.push(v & 0xff); }
  unsignedVB(v: number) { v >>>= 0; while (v > 127) { this.byte((v & 0x7f) | 0x80); v >>>= 7; } this.byte(v); }
  signedVB(v: number) { this.unsignedVB(((v << 1) ^ (v >> 31)) >>> 0); }
  text(t: string) { for (const c of t) this.byte(c.charCodeAt(0)); }
}
const fits = (v: number, bits: number) => v >= -(1 << (bits - 1)) && v < (1 << (bits - 1));
export function writeTag2_3S32(w: BitWriter, v: number[]) {
  if (v.every(x => fits(x, 2))) w.byte(((v[0] & 3) << 4) | ((v[1] & 3) << 2) | (v[2] & 3));
  else if (v.every(x => fits(x, 4))) { w.byte(0x40 | (v[0] & 0x0f)); w.byte(((v[1] & 0x0f) << 4) | (v[2] & 0x0f)); }
  else if (v.every(x => fits(x, 6))) { w.byte(0x80 | (v[0] & 0x3f)); w.byte(v[1] & 0x3f); w.byte(v[2] & 0x3f); }
  else {
    const sizes = v.map(x => fits(x, 8) ? 0 : fits(x, 16) ? 1 : fits(x, 24) ? 2 : 3);
    w.byte(0xc0 | sizes[0] | (sizes[1] << 2) | (sizes[2] << 4));
    v.forEach((x, i) => { for (let b = 0; b <= sizes[i]; b++) w.byte(x >> (8 * b)); });
  }
}
export function writeTag8_4S16v2(w: BitWriter, v: number[]) {
  const sel = v.map(x => x === 0 ? 0 : fits(x, 4) ? 1 : fits(x, 8) ? 2 : 3);
  w.byte(sel[0] | (sel[1] << 2) | (sel[2] << 4) | (sel[3] << 6));
  let buffer = 0, nibble = 0;
  v.forEach((x, i) => {
    switch (sel[i]) {
      case 0: break;
      case 1: if (nibble === 0) { buffer = (x & 0x0f) << 4; nibble = 1; } else { w.byte(buffer | (x & 0x0f)); nibble = 0; } break;
      case 2: if (nibble === 0) w.byte(x); else { w.byte(buffer | ((x >> 4) & 0x0f)); buffer = (x & 0x0f) << 4; } break;
      case 3: if (nibble === 0) { w.byte(x >> 8); w.byte(x); } else { w.byte(buffer | ((x >> 12) & 0x0f)); w.byte(x >> 4); buffer = (x & 0x0f) << 4; } break;
    }
  });
  if (nibble === 1) w.byte(buffer);
}
export function writeTag8_8SVB(w: BitWriter, v: number[]) {
  if (v.length === 1) { w.signedVB(v[0]); return; }
  let header = 0;
  v.forEach((x, i) => { if (x !== 0) header |= 1 << i; });
  w.byte(header);
  for (const x of v) if (x !== 0) w.signedVB(x);
}

/** A small Betaflight-style log: setpoint and gyro per axis, motors, throttle, battery and accelerometer. */
export function syntheticBlackbox(seconds = 6, shake = 1, rateHz = 250, out?: number[][]): Uint8Array {
  const names = ['loopIteration', 'time', 'axisP[0]', 'axisP[1]', 'axisP[2]', 'rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]', 'rcCommand[3]', 'setpoint[0]', 'setpoint[1]', 'setpoint[2]',
    'vbatLatest', 'amperageLatest', 'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]', 'accSmooth[0]', 'accSmooth[1]', 'accSmooth[2]', 'motor[0]', 'motor[1]', 'motor[2]', 'motor[3]'];
  const signed = [0, 0, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0];
  const iPred = [0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0, 0, 11, 5, 5, 5];
  const iEnc = [1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
  const pPred = [6, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 3, 3];
  const pEnc = [9, 0, 7, 7, 7, 8, 8, 8, 8, 7, 7, 7, 0, 0, 6, 6, 6, 6, 6, 6, 8, 8, 8, 8];
  const w = new BitWriter();
  const headers: [string, string][] = [
    ['Product', 'Blackbox flight data recorder by Nicholas Sherlock'], ['Data version', '2'], ['I interval', '32'], ['P interval', '1/1'],
    ['Firmware type', 'Cleanflight'], ['Firmware revision', 'Betaflight 4.5.1 (77d01ba3b) STM32F405'], ['Craft name', 'DEMO5'],
    ['Field I name', names.join(',')], ['Field I signed', signed.join(',')], ['Field I predictor', iPred.join(',')], ['Field I encoding', iEnc.join(',')],
    ['Field P predictor', pPred.join(',')], ['Field P encoding', pEnc.join(',')], ['Field S name', 'flightModeFlags,stateFlags,failsafePhase,rxSignalReceived,rxFlightChannelsValid'],
    ['Field S signed', '0,0,0,0,0'], ['Field S predictor', '0,0,0,0,0'], ['Field S encoding', '1,1,7,7,7'],
    ['minthrottle', '1070'], ['vbatref', '1610'], ['motorOutput', '48,2047'], ['acc_1G', '2048'], ['looptime', String(Math.round(1e6 / rateHz))],
  ];
  for (const [k, v] of headers) w.text(`H ${k}:${v}\n`);
  let prev: number[] | undefined, prev2: number[] | undefined;
  const total = Math.round(seconds * rateHz);
  for (let n = 0; n < total; n++) {
    const t = n / rateHz;
    const throttle = 1200 + Math.round(400 * Math.min(1, t / 2));
    const sp = [Math.round(80 * Math.sin(t * 2)), Math.round(60 * Math.cos(t * 1.5)), Math.round(20 * Math.sin(t))];
    const noise = (k: number) => Math.round(shake * 40 * Math.sin(t * 2 * Math.PI * 180 + k) * ((throttle - 1000) / 1000));
    const gyro = sp.map((x, k) => x + noise(k) + Math.round(3 * Math.sin(t * 7 + k)));
    const acc = [noise(1) * 12, noise(2) * 12, 2048 + noise(3) * 10];
    const motorBase = 48 + Math.round(((throttle - 1000) / 1000) * 1999);
    const motors = [0, 1, 2, 3].map(k => Math.min(2047, motorBase + Math.round(30 * Math.sin(t * 3 + k))));
    const frame = [n, Math.round(t * 1e6), ...sp.map(x => Math.round(x * 0.4)), sp[0], sp[1], sp[2], throttle, ...sp, 1610 - Math.round(t * 8) - Math.round(((throttle - 1000) / 1000) * 60), Math.round(((throttle - 1000) / 1000) * 3500), ...gyro, ...acc, ...motors];
    for (let k = 0; k < frame.length; k++) frame[k] |= 0;
    out?.push(frame);
    const isI = n % 32 === 0;
    if (isI) {
      w.byte(0x49);
      frame.forEach((v, i) => {
        let raw = v;
        if (iPred[i] === 4) raw -= 1070; else if (iPred[i] === 9) raw -= 1610; else if (iPred[i] === 11) raw -= 48; else if (iPred[i] === 5) raw -= frame[20];
        if (iEnc[i] === 1) w.unsignedVB(raw); else if (iEnc[i] === 0) w.signedVB(raw); else if (iEnc[i] === 3) w.unsignedVB((-raw) & 0x3fff);
      });
      prev2 = frame; prev = frame;
    } else {
      w.byte(0x50);
      const p = prev!, q = prev2!;
      const residual = frame.map((v, i) => pPred[i] === 1 ? v - p[i] : pPred[i] === 2 ? v - (2 * p[i] - q[i]) : pPred[i] === 3 ? v - Math.trunc((p[i] + q[i]) / 2) : 0);
      let i = 0;
      while (i < frame.length) {
        if (pPred[i] === 6) { i++; continue; }
        const enc = pEnc[i];
        if (enc === 0) { w.signedVB(residual[i]); i++; }
        else if (enc === 7) { writeTag2_3S32(w, residual.slice(i, i + 3)); i += 3; }
        else if (enc === 8) { writeTag8_4S16v2(w, residual.slice(i, i + 4)); i += 4; }
        else if (enc === 6) { let j = i + 1; while (j < i + 8 && j < frame.length && pEnc[j] === 6) j++; writeTag8_8SVB(w, residual.slice(i, j)); i = j; }
        else i++;
      }
      prev2 = prev; prev = frame;
    }
    if (n % rateHz === 0) { w.byte(0x53); w.unsignedVB(t > 2 ? 1 : 0); w.unsignedVB(0); writeTag2_3S32(w, [0, 1, 1]); }
  }
  w.byte(0x45); w.byte(15); w.unsignedVB(4);
  w.byte(0x45); w.byte(255); w.text('End of log\0');
  return Uint8Array.from(w.bytes);
}
