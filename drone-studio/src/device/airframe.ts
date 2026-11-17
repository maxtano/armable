import type { Airframe, MotorSlot } from './types';

/** Motor layouts, as the firmware projects document them. Angles are degrees clockwise from the nose. */
type Spec = [number: number, angle: number, spin: 'cw' | 'ccw'][];
const at = (spec: Spec): MotorSlot[] => spec.map(([number, angle, spin]) => ({
  number, spin, x: +Math.sin((angle * Math.PI) / 180).toFixed(3), y: +Math.cos((angle * Math.PI) / 180).toFixed(3),
}));
const flip = (motors: MotorSlot[]): MotorSlot[] => motors.map(m => ({ ...m, spin: m.spin === 'cw' ? 'ccw' : m.spin === 'ccw' ? 'cw' : 'unknown' }));

// ArduPilot AP_MotorsMatrix: FRAME_CLASS / FRAME_TYPE.
const ARDU: Record<string, { label: string; motors: Spec }> = {
  '1/0': { label: 'Quad +', motors: [[1, 90, 'ccw'], [2, -90, 'ccw'], [3, 0, 'cw'], [4, 180, 'cw']] },
  '1/1': { label: 'Quad X', motors: [[1, 45, 'ccw'], [2, -135, 'ccw'], [3, -45, 'cw'], [4, 135, 'cw']] },
  '1/3': { label: 'Quad H', motors: [[1, 45, 'cw'], [2, -135, 'cw'], [3, -45, 'ccw'], [4, 135, 'ccw']] },
  '1/12': { label: 'Quad X · Betaflight order', motors: [[1, 135, 'cw'], [2, 45, 'ccw'], [3, -135, 'ccw'], [4, -45, 'cw']] },
  '1/13': { label: 'Quad X · DJI order', motors: [[1, 45, 'ccw'], [2, -45, 'cw'], [3, -135, 'ccw'], [4, 135, 'cw']] },
  '1/14': { label: 'Quad X · clockwise order', motors: [[1, -45, 'cw'], [2, 45, 'ccw'], [3, 135, 'cw'], [4, -135, 'ccw']] },
  '1/18': { label: 'Quad X · Betaflight order, props out', motors: [[1, 135, 'ccw'], [2, 45, 'cw'], [3, -135, 'cw'], [4, -45, 'ccw']] },
  '2/0': { label: 'Hex +', motors: [[1, 0, 'cw'], [2, 180, 'ccw'], [3, -120, 'cw'], [4, 60, 'ccw'], [5, -60, 'ccw'], [6, 120, 'cw']] },
  '2/1': { label: 'Hex X', motors: [[1, 90, 'cw'], [2, -90, 'ccw'], [3, -30, 'cw'], [4, 150, 'ccw'], [5, 30, 'ccw'], [6, -150, 'cw']] },
  '3/1': { label: 'Octo X', motors: [[1, 22.5, 'cw'], [2, -157.5, 'cw'], [3, 67.5, 'ccw'], [4, 157.5, 'ccw'], [5, -22.5, 'ccw'], [6, -112.5, 'ccw'], [7, -67.5, 'cw'], [8, 112.5, 'cw']] },
};
const CLASS_COUNT: Record<number, number> = { 1: 4, 2: 6, 3: 8, 4: 8, 5: 6, 7: 3, 12: 12, 14: 10 };

/** A ring of motors with no claimed order or direction, for layouts Lucidity does not know. */
export function unknownFrame(count: number, label = 'Unknown layout'): Airframe {
  const motors: MotorSlot[] = Array.from({ length: count }, (_, i) => {
    const angle = (360 / count) * i + (count % 2 ? 0 : 180 / count);
    return { number: i + 1, spin: 'unknown', x: +Math.sin((angle * Math.PI) / 180).toFixed(3), y: +Math.cos((angle * Math.PI) / 180).toFixed(3) };
  });
  return { id: `unknown-${count}`, label, motors, known: false };
}
export function ardupilotFrame(frameClass: number | undefined, frameType: number | undefined, fallbackCount = 4): Airframe {
  const hit = ARDU[`${frameClass}/${frameType}`];
  if (hit) return { id: `ardupilot-${frameClass}-${frameType}`, label: hit.label, motors: at(hit.motors), known: true };
  return unknownFrame(CLASS_COUNT[frameClass ?? 0] ?? fallbackCount, frameClass === undefined ? 'Layout not read yet' : `Frame class ${frameClass}, type ${frameType}`);
}
// Betaflight mixer.c: QUADX is rear-right, front-right, rear-left, front-left.
const BF: Record<number, { label: string; motors: Spec }> = {
  3: { label: 'Quad X', motors: [[1, 135, 'cw'], [2, 45, 'ccw'], [3, -135, 'ccw'], [4, -45, 'cw']] },
  2: { label: 'Quad +', motors: [[1, 180, 'cw'], [2, 90, 'ccw'], [3, -90, 'ccw'], [4, 0, 'cw']] },
};
const BF_COUNT: Record<number, number> = { 1: 3, 2: 4, 3: 4, 4: 2, 6: 6, 7: 6, 9: 4, 10: 6, 11: 8, 12: 8, 13: 8, 17: 4, 18: 6 };
export function betaflightFrame(mixer: number | undefined, yawReversed: boolean, motorCount = 4): Airframe {
  const hit = mixer === undefined ? undefined : BF[mixer];
  if (hit) return { id: `betaflight-${mixer}${yawReversed ? '-reversed' : ''}`, label: yawReversed ? `${hit.label} · props out` : hit.label, motors: yawReversed ? flip(at(hit.motors)) : at(hit.motors), known: true };
  return unknownFrame(BF_COUNT[mixer ?? 0] ?? motorCount, mixer === undefined ? 'Layout not read yet' : `Mixer ${mixer}`);
}
/** PX4 publishes real rotor positions and spin in its control-allocation parameters. */
export function px4Frame(param: (name: string) => number | undefined): Airframe {
  const count = param('CA_ROTOR_COUNT');
  if (!count) return unknownFrame(4, 'Layout not read yet');
  const raw = Array.from({ length: count }, (_, i) => ({ px: param(`CA_ROTOR${i}_PX`), py: param(`CA_ROTOR${i}_PY`), km: param(`CA_ROTOR${i}_KM`) }));
  if (raw.some(r => r.px === undefined || r.py === undefined)) return unknownFrame(count, 'Layout not read yet');
  const reach = Math.max(...raw.map(r => Math.hypot(r.px!, r.py!)), 1e-6);
  return {
    id: 'px4-control-allocation', label: `${count} rotors`, known: true,
    motors: raw.map((r, i) => ({ number: i + 1, x: +(r.py! / reach).toFixed(3), y: +(r.px! / reach).toFixed(3), spin: r.km === undefined || r.km === 0 ? 'unknown' : r.km > 0 ? 'ccw' : 'cw' })),
  };
}
