import { BETAFLIGHT_FEATURED } from '../device/betaflight/cli';
import { ARDUPILOT_FEATURED } from '../device/mavlink/meta';
import type { PartId, Setting, Stack, TestSpec } from '../device/types';

/** Names and the handful of things shown first for each part. Three words at most. */
export const PART_NAME: Record<PartId, string> = {
  fc: 'Flight controller', motors: 'Motors', battery: 'Battery', receiver: 'Radio', gps: 'GPS', link: 'Connection', tuning: 'Tuning', safety: 'Safety',
  osd: 'On-screen display', vtx: 'Video', lights: 'Lights', ports: 'Ports', compass: 'Compass', logging: 'Flight logs', other: 'Other',
};
/** Parts that have no drawing of their own. They sit in a row of chips above the diagram. */
export const CHIP_PARTS: PartId[] = ['tuning', 'safety', 'ports', 'vtx', 'osd', 'lights', 'compass', 'logging'];
const ORDER: Partial<Record<PartId, string[]>> = {
  motors: ['motor.spin', 'esc.read', 'esc.flash'], fc: ['diagnostics.full', 'cal.level', 'cal.accel', 'fc.restart', 'cal.gyro', 'cal.accel.simple', 'cal.baro', 'settings.snapshot', 'settings.restore', 'firmware.flash', 'sensors.check'],
  battery: ['battery.check'], receiver: ['radio.check'], safety: ['prearm.check'], link: ['link.check'], compass: ['cal.compass'], logging: ['logs.analyze', 'logs.list'],
};
/** Short button words for tests. */
export const BUTTON: Record<string, string> = {
  'motor.spin': 'Test', 'esc.read': 'Read ESCs', 'esc.flash': 'Flash ESCs', 'diagnostics.full': 'Check all', 'cal.level': 'Level', 'cal.accel': 'Level', 'cal.accel.simple': 'Calibrate accel',
  'cal.gyro': 'Calibrate gyro', 'cal.baro': 'Zero altitude', 'cal.compass': 'Calibrate', 'fc.restart': 'Restart', 'settings.snapshot': 'Back up', 'settings.restore': 'Restore',
  'firmware.flash': 'Flash firmware', 'battery.check': 'Check', 'radio.check': 'Check', 'prearm.check': 'Check', 'link.check': 'Check', 'sensors.check': 'Check sensors', 'logs.analyze': 'Analyse latest', 'logs.list': 'List logs',
};
export function testsFor(part: PartId, tests: TestSpec[]): TestSpec[] {
  const order = ORDER[part] ?? [];
  return tests.filter(t => t.part === part).sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
}
export function featured(part: PartId, stack: Stack | undefined, settings: Setting[]): Setting[] {
  const mavlink = stack === 'ardupilot' || stack === 'px4';
  const names = (mavlink ? ARDUPILOT_FEATURED : BETAFLIGHT_FEATURED)[part] ?? [];
  const prefix = mavlink ? 'param.' : 'bf.';
  const picked = names.flatMap(n => settings.find(s => s.id === prefix + n) ?? []);
  if (picked.length >= 3) return picked;
  // Nothing curated for this firmware: show the first few the firmware reports for the part.
  return [...picked, ...settings.filter(s => s.part === part && !picked.includes(s) && !s.id.startsWith('esc.')).slice(0, 8 - picked.length)];
}
export const format = (value: unknown, unit?: string) => value === undefined || value === null ? '—' : `${typeof value === 'number' ? (Number.isInteger(value) ? value : Number(value.toFixed(4))) : value}${unit ? ` ${unit}` : ''}`;
export const optionLabel = (s: Setting, value: unknown) => s.options?.find(o => String(o.value).toLowerCase() === String(value).toLowerCase())?.label ?? format(value);
