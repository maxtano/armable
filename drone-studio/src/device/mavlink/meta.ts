import type { PartId, Setting } from '../types';

export const COPTER_MODES: Record<number, string> = {
  0: 'Stabilize', 1: 'Acro', 2: 'AltHold', 3: 'Auto', 4: 'Guided', 5: 'Loiter', 6: 'RTL', 7: 'Circle', 9: 'Land', 11: 'Drift', 13: 'Sport',
  14: 'Flip', 15: 'AutoTune', 16: 'PosHold', 17: 'Brake', 18: 'Throw', 19: 'Avoid ADSB', 20: 'Guided NoGPS', 21: 'Smart RTL', 22: 'FlowHold',
  23: 'Follow', 24: 'ZigZag', 25: 'SystemID', 26: 'Autorotate', 27: 'Auto RTL', 28: 'Turtle',
};
const PX4_MAIN: Record<number, string> = { 1: 'Manual', 2: 'Altitude', 3: 'Position', 4: 'Auto', 5: 'Acro', 6: 'Offboard', 7: 'Stabilized', 8: 'Rattitude' };
const PX4_AUTO: Record<number, string> = { 1: 'Ready', 2: 'Takeoff', 3: 'Hold', 4: 'Mission', 5: 'Return', 6: 'Land', 8: 'Follow' };
export function modeName(px4: boolean, custom: number): string {
  if (!px4) return COPTER_MODES[custom] ?? `Mode ${custom}`;
  const main = (custom >> 16) & 0xff, sub = (custom >> 24) & 0xff;
  return main === 4 ? PX4_AUTO[sub] ?? 'Auto' : PX4_MAIN[main] ?? `Mode ${main}`;
}
export const SENSOR_BITS: [bit: number, key: string][] = [
  [0x01, 'gyro'], [0x02, 'accel'], [0x04, 'compass'], [0x08, 'baro'], [0x20, 'gps'], [0x10000, 'receiver'], [0x200000, 'ahrs'], [0x2000000, 'battery'], [0x1000000, 'logging'],
];
export const PREARM_BIT = 0x10000000;
export const RESULT: Record<number, string> = { 0: 'accepted', 1: 'temporarily rejected', 2: 'denied', 3: 'unsupported', 4: 'failed', 5: 'in progress', 6: 'cancelled' };

const PREFIX_PART: [RegExp, PartId, string][] = [
  [/^(MOT_|SERVO|ESC_|H_)/, 'motors', 'Motors and outputs'],
  [/^(BATT|BAT\d?_)/, 'battery', 'Battery'],
  [/^(RC\d*_|RCMAP_|RSSI_|FLTMODE|MODE_CH|RC_|COM_RC|RC_MAP)/, 'receiver', 'Receiver and modes'],
  [/^(GPS|EK3_SRC|EK3_GPS)/, 'gps', 'GPS'],
  [/^(COMPASS_|CAL_MAG)/, 'compass', 'Compass'],
  [/^(ATC_|PSC_|PILOT_|ACRO_|AUTOTUNE_|INS_GYRO_FILTER|INS_ACCEL_FILTER|INS_HNTCH|INS_HNTC2|FILT|MC_|MPC_|IMU_GYRO_|IMU_DGYRO_|WPNAV_|LOIT_|ANGLE_MAX)/, 'tuning', 'Tuning'],
  [/^(FS_|FENCE_|RTL_|ARMING_|DISARM_|BRD_SAFETY|COM_|NAV_RCL|NAV_DLL|GF_|LAND_)/, 'safety', 'Failsafe and arming'],
  [/^(SERIAL|CAN_|BRD_SER|MAV_|SR\d_|NET_)/, 'ports', 'Ports'],
  [/^(OSD)/, 'osd', 'OSD'],
  [/^(VTX_)/, 'vtx', 'Video transmitter'],
  [/^(NTF_|LED_)/, 'lights', 'Lights and buzzer'],
  [/^(LOG_|SDLOG_)/, 'logging', 'Logging'],
  [/^(FRAME_|AHRS_|INS_|EK\d_|BRD_|SCHED_|SYSID_|SYS_|SENS_|CAL_|CA_)/, 'fc', 'Flight controller'],
];
export function partOf(name: string): { part: PartId; group: string } {
  for (const [pattern, part, group] of PREFIX_PART) if (pattern.test(name)) return { part, group };
  return { part: 'other', group: name.includes('_') ? name.split('_')[0] : 'Other' };
}

type Meta = Partial<Pick<Setting, 'title' | 'description' | 'unit' | 'min' | 'max' | 'step' | 'rebootRequired'>> & { options?: Record<number, string> };
/**
 * A small built-in description set so the product explains the most-used ArduPilot settings with no network.
 * The full, version-matched set is loaded from the ArduPilot project's published metadata when it is reachable.
 */
export const ARDUPILOT_META: Record<string, Meta> = {
  FRAME_CLASS: { title: 'Frame class', description: 'The kind of multicopter.', rebootRequired: true, options: { 0: 'Undefined', 1: 'Quad', 2: 'Hexa', 3: 'Octa', 4: 'OctaQuad', 5: 'Y6', 6: 'Heli', 7: 'Tri' } },
  FRAME_TYPE: { title: 'Frame type', description: 'Motor arrangement and order.', rebootRequired: true, options: { 0: 'Plus', 1: 'X', 2: 'V', 3: 'H', 12: 'Betaflight X', 13: 'DJI X', 14: 'Clockwise X', 18: 'Betaflight X reversed' } },
  MOT_PWM_TYPE: { title: 'Motor protocol', description: 'Signal the flight controller sends to the ESCs.', rebootRequired: true, options: { 0: 'Normal', 1: 'OneShot', 2: 'OneShot125', 3: 'Brushed', 4: 'DShot150', 5: 'DShot300', 6: 'DShot600', 7: 'DShot1200' } },
  MOT_SPIN_ARM: { title: 'Spin when armed', description: 'Motor output while armed and idle.', min: 0, max: 0.3, step: 0.01 },
  MOT_SPIN_MIN: { title: 'Minimum spin', description: 'Lowest motor output in flight.', min: 0, max: 0.3, step: 0.01 },
  MOT_BAT_VOLT_MAX: { title: 'Battery voltage, full', unit: 'V', min: 0, max: 60, step: 0.1 },
  MOT_BAT_VOLT_MIN: { title: 'Battery voltage, empty', unit: 'V', min: 0, max: 60, step: 0.1 },
  SERVO_BLH_AUTO: { title: 'ESC passthrough', description: 'Lets Armable reach the ESCs through the flight controller.', options: { 0: 'Off', 1: 'On' }, rebootRequired: true },
  SERVO_BLH_PORT: { title: 'ESC passthrough port', description: 'Which port carries ESC passthrough. 0 is USB.', rebootRequired: true },
  SERVO_DSHOT_ESC: { title: 'DShot ESC type', options: { 0: 'None', 1: 'BLHeli32 / BLHeli_S', 2: 'BLHeli_S / Bluejay extended', 3: 'AM32' } },
  BATT_MONITOR: { title: 'Battery monitor', description: 'How battery voltage and current are measured.', rebootRequired: true, options: { 0: 'Off', 3: 'Voltage only', 4: 'Voltage and current', 9: 'ESC telemetry' } },
  BATT_CAPACITY: { title: 'Battery capacity', unit: 'mAh', min: 0, max: 100000, step: 50 },
  BATT_LOW_VOLT: { title: 'Low battery voltage', unit: 'V', min: 0, max: 60, step: 0.1 },
  BATT_CRT_VOLT: { title: 'Critical battery voltage', unit: 'V', min: 0, max: 60, step: 0.1 },
  BATT_FS_LOW_ACT: { title: 'Low battery action', options: { 0: 'None', 1: 'Land', 2: 'RTL', 3: 'Smart RTL', 4: 'Smart RTL or Land', 5: 'Terminate' } },
  BATT_FS_CRT_ACT: { title: 'Critical battery action', options: { 0: 'None', 1: 'Land', 2: 'RTL', 3: 'Smart RTL', 4: 'Smart RTL or Land', 5: 'Terminate' } },
  BATT_VOLT_MULT: { title: 'Voltage scale', description: 'Calibrates the voltage reading.', min: 0, max: 100, step: 0.01 },
  FS_THR_ENABLE: { title: 'Radio loss action', options: { 0: 'Disabled', 1: 'RTL', 2: 'Continue mission', 3: 'Land', 4: 'Smart RTL or RTL', 5: 'Smart RTL or Land' } },
  FS_THR_VALUE: { title: 'Radio loss throttle', unit: 'PWM', min: 910, max: 1100, step: 1 },
  FS_GCS_ENABLE: { title: 'Ground station loss action', options: { 0: 'Disabled', 1: 'RTL', 2: 'Continue mission', 3: 'Smart RTL or RTL', 4: 'Smart RTL or Land', 5: 'Land' } },
  ARMING_CHECK: { title: 'Arming checks', description: 'Which pre-arm checks run. 1 runs all of them.' },
  FLTMODE_CH: { title: 'Mode switch channel', min: 0, max: 16, step: 1 },
  FLTMODE1: { title: 'Flight mode 1' }, FLTMODE2: { title: 'Flight mode 2' }, FLTMODE3: { title: 'Flight mode 3' },
  FLTMODE4: { title: 'Flight mode 4' }, FLTMODE5: { title: 'Flight mode 5' }, FLTMODE6: { title: 'Flight mode 6' },
  ATC_RAT_RLL_P: { title: 'Roll rate P', min: 0.01, max: 0.5, step: 0.005 }, ATC_RAT_RLL_I: { title: 'Roll rate I', min: 0.01, max: 2, step: 0.01 }, ATC_RAT_RLL_D: { title: 'Roll rate D', min: 0, max: 0.05, step: 0.001 },
  ATC_RAT_PIT_P: { title: 'Pitch rate P', min: 0.01, max: 0.5, step: 0.005 }, ATC_RAT_PIT_I: { title: 'Pitch rate I', min: 0.01, max: 2, step: 0.01 }, ATC_RAT_PIT_D: { title: 'Pitch rate D', min: 0, max: 0.05, step: 0.001 },
  ATC_RAT_YAW_P: { title: 'Yaw rate P', min: 0.1, max: 2.5, step: 0.005 }, ATC_RAT_YAW_I: { title: 'Yaw rate I', min: 0.01, max: 1, step: 0.01 },
  ATC_ANG_RLL_P: { title: 'Roll angle P', min: 3, max: 12, step: 0.1 }, ATC_ANG_PIT_P: { title: 'Pitch angle P', min: 3, max: 12, step: 0.1 }, ATC_ANG_YAW_P: { title: 'Yaw angle P', min: 3, max: 12, step: 0.1 },
  INS_GYRO_FILTER: { title: 'Gyro filter', unit: 'Hz', min: 0, max: 256, step: 1 },
  INS_HNTCH_ENABLE: { title: 'Harmonic notch', options: { 0: 'Off', 1: 'On' }, rebootRequired: true },
  AHRS_ORIENTATION: { title: 'Board orientation', description: 'How the flight controller is mounted.', rebootRequired: true },
  AHRS_TRIM_X: { title: 'Level trim, roll', unit: 'rad', min: -0.1745, max: 0.1745, step: 0.001 },
  AHRS_TRIM_Y: { title: 'Level trim, pitch', unit: 'rad', min: -0.1745, max: 0.1745, step: 0.001 },
  GPS_TYPE: { title: 'GPS type', rebootRequired: true, options: { 0: 'None', 1: 'Auto', 2: 'uBlox', 5: 'NMEA', 9: 'DroneCAN', 19: 'MSP' } },
  GPS1_TYPE: { title: 'GPS type', rebootRequired: true, options: { 0: 'None', 1: 'Auto', 2: 'uBlox', 5: 'NMEA', 9: 'DroneCAN', 19: 'MSP' } },
  COMPASS_ENABLE: { title: 'Compass', options: { 0: 'Off', 1: 'On' }, rebootRequired: true },
  LOG_BITMASK: { title: 'What gets logged' },
  LOG_DISARMED: { title: 'Log while disarmed', options: { 0: 'Off', 1: 'On', 2: 'Off on USB', 3: 'Discard if never armed' } },
  RSSI_TYPE: { title: 'Signal strength source', options: { 0: 'Off', 1: 'Analog pin', 2: 'RC channel', 3: 'Receiver protocol', 4: 'PWM pin', 5: 'Telemetry radio' } },
  SERIAL0_PROTOCOL: { title: 'USB protocol', options: { 1: 'MAVLink 1', 2: 'MAVLink 2' }, rebootRequired: true },
  RTL_ALT: { title: 'Return altitude', unit: 'cm', min: 30, max: 300000, step: 10 },
  FENCE_ENABLE: { title: 'Geofence', options: { 0: 'Off', 1: 'On' } },
  ANGLE_MAX: { title: 'Maximum lean angle', unit: 'cdeg', min: 1000, max: 8000, step: 100 },
};
/** Settings shown first on a part, before "all settings". */
export const ARDUPILOT_FEATURED: Record<string, string[]> = {
  motors: ['MOT_PWM_TYPE', 'MOT_SPIN_ARM', 'MOT_SPIN_MIN', 'SERVO_BLH_AUTO', 'FRAME_TYPE'],
  battery: ['BATT_MONITOR', 'BATT_CAPACITY', 'BATT_LOW_VOLT', 'BATT_CRT_VOLT', 'BATT_FS_LOW_ACT'],
  receiver: ['FS_THR_ENABLE', 'FLTMODE_CH', 'FLTMODE1', 'FLTMODE2', 'FLTMODE3', 'RSSI_TYPE'],
  gps: ['GPS_TYPE', 'GPS1_TYPE'], compass: ['COMPASS_ENABLE'],
  fc: ['FRAME_CLASS', 'FRAME_TYPE', 'AHRS_ORIENTATION', 'ARMING_CHECK', 'LOG_DISARMED'],
  tuning: ['ATC_RAT_RLL_P', 'ATC_RAT_RLL_I', 'ATC_RAT_RLL_D', 'ATC_RAT_PIT_P', 'ATC_RAT_PIT_I', 'ATC_RAT_PIT_D', 'ATC_RAT_YAW_P', 'INS_GYRO_FILTER'],
  safety: ['FS_THR_ENABLE', 'BATT_FS_LOW_ACT', 'FS_GCS_ENABLE', 'FENCE_ENABLE', 'RTL_ALT'],
};
/** ArduPilot's published metadata (apm.pdef.json), reduced to what Armable shows. */
export function fromPdef(json: unknown): Record<string, Meta> {
  const out: Record<string, Meta> = {};
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      if (typeof v.DisplayName === 'string' || typeof v.Description === 'string') {
        const meta: Meta = { title: v.DisplayName as string | undefined, description: v.Description as string | undefined, unit: v.Units as string | undefined };
        const range = v.Range as { low?: string; high?: string } | undefined;
        if (range && Number.isFinite(+range.low!) && Number.isFinite(+range.high!)) { meta.min = +range.low!; meta.max = +range.high!; }
        if (v.Increment && Number.isFinite(+(v.Increment as string))) meta.step = +(v.Increment as string);
        if (v.RebootRequired === 'True') meta.rebootRequired = true;
        if (v.Values && typeof v.Values === 'object') meta.options = Object.fromEntries(Object.entries(v.Values as Record<string, string>).map(([k, label]) => [Number(k), label]));
        out[key.includes(':') ? key.split(':').pop()! : key] = meta;
      } else walk(value);
    }
  };
  walk(json);
  return out;
}
