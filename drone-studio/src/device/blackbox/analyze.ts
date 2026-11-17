import type { FlightLogAnalysis, NumericSummary } from '../../aircraft/dataflash-analysis';
import type { BlackboxLog } from './decode';

/**
 * Turns a decoded Betaflight log into the same summary the Flights view shows for ArduPilot logs.
 * Vibration comes from the accelerometer with the slow part removed (m/s², so the same 15/30 guides apply);
 * tracking error is setpoint minus gyro, per axis, in deg/s.
 */
const TRACE = 600;
function summary(values: number[], times: number[]): NumericSummary | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  let peakAt = 0;
  values.forEach((v, i) => { if (v > values[peakAt]) peakAt = i; });
  return { samples: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], peak: values[peakAt], peakTimeSeconds: times[peakAt] ?? null };
}
const thin = <T>(rows: T[]) => rows.length <= TRACE ? rows : Array.from({ length: TRACE }, (_, i) => rows[Math.floor((i * rows.length) / TRACE)]);
function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 20) return null;
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n, mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}

export function analyzeBlackbox(log: BlackboxLog): FlightLogAnalysis {
  const f = (name: string) => log.fields.indexOf(name);
  const col = (name: string) => { const i = f(name); return i < 0 ? undefined : log.frames.map(r => r[i]); };
  const t0 = log.frames[0]?.[f('time')] ?? 0;
  const times = (col('time') ?? log.frames.map((_, i) => i * 1000)).map(t => (t - t0) / 1e6);
  const caveats: string[] = [];
  // Rate tracking.
  const axis = (k: number) => { const sp = col(`setpoint[${k}]`), gy = col(`gyroADC[${k}]`); return sp && gy ? { sp, gy, err: gy.map((g, i) => Math.abs(sp[i] - g)) } : undefined; };
  const roll = axis(0), pitch = axis(1), yaw = axis(2);
  if (!roll) caveats.push('No setpoint or gyro fields were logged, so tracking cannot be assessed.');
  // Vibration: accelerometer minus a running mean, converted to m/s².
  const g1 = Number(log.headers.acc_1G ?? 2048) || 2048;
  const vib = [0, 1, 2].map(k => {
    const a = col(`accSmooth[${k}]`);
    if (!a) return undefined;
    let mean = a[0];
    return a.map(v => { mean += (v - mean) * 0.02; return Math.abs(((v - mean) / g1) * 9.80665); });
  });
  if (!vib[0]) caveats.push('No accelerometer fields were logged, so vibration cannot be assessed.');
  // Throttle as motor output, 0..1 across the motor range.
  const [lo, hi] = (log.headers.motorOutput ?? '48,2047').split(',').map(Number);
  const motorCols = [0, 1, 2, 3, 4, 5, 6, 7].map(k => col(`motor[${k}]`)).filter((m): m is number[] => !!m);
  const throttle = motorCols.length ? log.frames.map((_, i) => Math.min(1, Math.max(0, (motorCols.reduce((s, m) => s + m[i], 0) / motorCols.length - lo) / ((hi - lo) || 1)))) : [];
  const vbat = col('vbatLatest')?.map(v => v / 100), amps = col('amperageLatest')?.map(v => v / 100);
  const magnitude = vib[0] && vib[1] && vib[2] ? vib[0].map((x, i) => Math.hypot(x, vib[1]![i], vib[2]![i])) : undefined;
  const modes = log.events.filter(e => e.type === 30).map(e => ({ timeSeconds: e.time !== undefined ? (e.time - t0) / 1e6 : 0, mode: e.data?.flags ?? 0 }));
  if (log.stats.corrupt) caveats.push(`${log.stats.corrupt} damaged frames were skipped.`);
  caveats.push('Betaflight logs record the accelerometer, not ArduPilot vibration; values are comparable in scale, not identical in method.');
  return {
    format: 'Betaflight Blackbox', bytes: log.stats.bytes, parsedRecords: log.frames.length, skippedBytes: 0, truncated: !log.events.some(e => e.type === 255),
    durationSeconds: times.length ? times[times.length - 1] : null,
    groups: { ATT: 0, RATE: roll ? log.frames.length : 0, VIBE: vib[0] ? log.frames.length : 0, CTUN: throttle.length, BAT: vbat ? log.frames.length : 0, MODE: modes.length },
    attitude: null,
    rate: roll ? { rollErrorDegS: summary(roll.err, times), pitchErrorDegS: pitch ? summary(pitch.err, times) : null, yawErrorDegS: yaw ? summary(yaw.err, times) : null } : null,
    vibration: vib[0] ? { sensors: [{ imu: 0, vibeX: summary(vib[0], times), vibeY: vib[1] ? summary(vib[1], times) : null, vibeZ: vib[2] ? summary(vib[2], times) : null, magnitude: magnitude ? summary(magnitude, times) : null, clippingEvents: null }] } : null,
    throttle: throttle.length ? { outputMin: Math.min(...throttle), outputMax: Math.max(...throttle), pairedVibrationSamples: magnitude ? throttle.length : 0, vibrationCorrelation: magnitude ? correlation(throttle, magnitude) : null } : null,
    battery: vbat ? { voltageMinV: Math.min(...vbat.filter(v => v > 0)), voltageMaxV: Math.max(...vbat), currentMaxA: amps ? Math.max(...amps) : null } : null,
    modes,
    traces: {
      attitude: [],
      rate: roll ? thin(times.map((t, i) => ({ timeSeconds: t, rollDegS: roll.gy[i], desiredRollDegS: roll.sp[i], pitchDegS: pitch?.gy[i] ?? 0, desiredPitchDegS: pitch?.sp[i] ?? 0 }))) : [],
      vibration: vib[0] ? thin(times.map((t, i) => ({ timeSeconds: t, imu: 0, vibeXMs2: vib[0]![i], vibeYMs2: vib[1]?.[i] ?? 0, vibeZMs2: vib[2]?.[i] ?? 0, magnitudeMs2: magnitude?.[i] ?? 0 }))) : [],
      throttle: thin(times.map((t, i) => ({ timeSeconds: t, output: throttle[i] ?? 0 }))),
    },
    caveats,
  };
}
