/** Builds a small, valid ArduPilot DataFlash log for the simulated aircraft. Synthetic; not a real flight. */
const SIZE: Record<string, number> = { B: 1, M: 1, I: 4, f: 4, Q: 8 };
function fmt(type: number, name: string, format: string, labels: string): Uint8Array {
  const record = new Uint8Array(89);
  record.set([0xa3, 0x95, 0x80, type, 3 + [...format].reduce((sum, ch) => sum + SIZE[ch], 0)]);
  const put = (offset: number, length: number, value: string) => record.set(new TextEncoder().encode(value).subarray(0, length), offset);
  put(5, 4, name); put(9, 16, format); put(25, 64, labels);
  return record;
}
function row(type: number, format: string, values: number[]): Uint8Array {
  const record = new Uint8Array(3 + [...format].reduce((sum, ch) => sum + SIZE[ch], 0));
  record.set([0xa3, 0x95, type]);
  const dv = new DataView(record.buffer);
  let at = 3;
  [...format].forEach((ch, i) => {
    if (ch === 'B' || ch === 'M') dv.setUint8(at, values[i]);
    else if (ch === 'I') dv.setUint32(at, values[i], true);
    else if (ch === 'Q') dv.setBigUint64(at, BigInt(Math.round(values[i])), true);
    else dv.setFloat32(at, values[i], true);
    at += SIZE[ch];
  });
  return record;
}
/** `shake` scales vibration and rate error; 1 is a rough flight, 0.2 a smooth one. */
export function syntheticLog(seconds = 20, shake = 1): Uint8Array {
  const parts = [
    fmt(1, 'ATT', 'QffffffB', 'TimeUS,DesRoll,Roll,DesPitch,Pitch,DesYaw,Yaw,AEKF'),
    fmt(2, 'RATE', 'Qffffff', 'TimeUS,RDes,R,PDes,P,YDes,Y'),
    fmt(3, 'VIBE', 'QBfffI', 'TimeUS,IMU,VibeX,VibeY,VibeZ,Clip'),
    fmt(4, 'CTUN', 'Qf', 'TimeUS,ThO'),
    fmt(5, 'BAT', 'QBff', 'TimeUS,Inst,Volt,Curr'),
    fmt(6, 'MODE', 'QMB', 'TimeUS,Mode,Rsn'),
    row(6, 'QMB', [0, 0, 1]),
  ];
  for (let i = 0; i < seconds * 10; i++) {
    const t = i * 100_000, s = i / 10;
    const throttle = 0.25 + 0.3 * Math.min(1, s / 4) + 0.1 * Math.sin(s);
    const wobble = Math.sin(s * 40) * 6 * shake * throttle;
    parts.push(
      row(1, 'QffffffB', [t, 5 * Math.sin(s), 5 * Math.sin(s) + wobble * 0.4, 0, wobble * 0.3, 90, 90, 3]),
      row(2, 'Qffffff', [t, 20 * Math.cos(s), 20 * Math.cos(s) + wobble * 9, 0, wobble * 7, 0, wobble]),
      row(3, 'QBfffI', [t, 0, 8 + 55 * shake * throttle, 7 + 48 * shake * throttle, 12 + 30 * shake * throttle, shake > 0.8 ? Math.floor(s / 5) : 0]),
      row(4, 'Qf', [t, throttle]),
      row(5, 'QBff', [t, 0, 16.4 - s * 0.03 - throttle, 4 + throttle * 30]),
    );
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
