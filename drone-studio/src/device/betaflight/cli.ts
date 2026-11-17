import { DeviceError } from '../bytes';
import type { PartId, Setting, SettingValue } from '../types';

/** Reading and writing Betaflight's text console. Every setting the firmware has is reachable here. */
export interface DumpSetting { name: string; value: string; scope?: string }
export interface Dump { settings: DumpSetting[]; serial: Record<string, string>; aux: Record<string, string>; map?: string; board?: string; other: string[] }

/** Values and identifiers that may be sent to the console. Anything else could smuggle in a second command. */
const SAFE_VALUE = /^[A-Za-z0-9 _.,:+\-]{0,128}$/;
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export function safeValue(value: SettingValue): string {
  const text = String(value).trim();
  if (!SAFE_VALUE.test(text)) throw new DeviceError('invalid', 'That value contains characters the flight controller console does not accept.');
  return text;
}
export function safeName(name: string): string {
  if (!SAFE_NAME.test(name)) throw new DeviceError('invalid', `"${name}" is not a valid setting name.`);
  return name;
}

export function parseDump(text: string): Dump {
  const dump: Dump = { settings: [], serial: {}, aux: {}, other: [] };
  let scope: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line === 'batch start' || line === 'batch end') continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^set (\w+) = (.*)$/))) dump.settings.push({ name: m[1], value: m[2].trim(), scope });
    else if ((m = line.match(/^(profile|rateprofile) (\d+)$/))) scope = `${m[1]} ${m[2]}`;
    else if ((m = line.match(/^serial (\S+) (.+)$/))) dump.serial[m[1]] = m[2];
    else if ((m = line.match(/^aux (\d+) (.+)$/))) dump.aux[m[1]] = m[2];
    else if ((m = line.match(/^map (\w+)$/))) dump.map = m[1];
    else if ((m = line.match(/^board_name (\S+)$/))) { dump.board = m[1]; dump.other.push(line); }
    else dump.other.push(line);
  }
  return dump;
}

export interface GetInfo { name: string; value: string; scope?: string; min?: number; max?: number; options?: string[]; default?: string; array?: number }
/** `get` matches by substring, so several settings can come back. Each is returned. */
export function parseGet(text: string): GetInfo[] {
  const out: GetInfo[] = [];
  let scope: string | undefined, current: GetInfo | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(profile|rateprofile) (\d+)$/))) scope = `${m[1]} ${m[2]}`;
    else if ((m = line.match(/^(\w+) = (.*)$/))) { current = { name: m[1], value: m[2].trim(), scope }; out.push(current); scope = undefined; }
    else if (current && (m = line.match(/^Allowed range: (-?[\d.]+) - (-?[\d.]+)$/))) { current.min = Number(m[1]); current.max = Number(m[2]); }
    else if (current && (m = line.match(/^Allowed values: (.+)$/))) current.options = m[1].split(',').map(v => v.trim()).filter(Boolean);
    else if (current && (m = line.match(/^Default value: (.*)$/))) current.default = m[1].trim();
    else if (current && (m = line.match(/^Array length: (\d+)$/))) current.array = Number(m[1]);
  }
  return out;
}

const PARTS: [RegExp, PartId, string][] = [
  [/^(gyro_lpf|gyro_lowpass|gyro_notch|dyn_notch|dyn_lpf|rpm_filter|dterm_|simplified_|anti_gravity|iterm_|pidsum|tpa_|feedforward|ff_|[pidf]_(roll|pitch|yaw)|d_min|d_max|rates_type|roll_|pitch_|yaw_(rc|expo|srate|lowpass|accel|rate)|thr_mid|thr_expo|throttle_limit|level_|angle_|horizon_|acro_trainer|abs_control|vbat_sag|thrust_linear|pid_|use_integrated_yaw|motor_output_limit)/, 'tuning', 'Tuning'],
  [/^(motor_|dshot_|min_command|max_throttle|min_throttle|yaw_motors_reversed|dyn_idle|idle_|esc_sensor|mixer_type|3d_|beeper_dshot)/, 'motors', 'Motors'],
  [/^(vbat_|ibat|bat_|battery_|current_meter|ibata_|ibatv_|cbat_|report_cell|use_vbat|force_battery)/, 'battery', 'Battery'],
  [/^(failsafe_|small_angle|auto_disarm|gps_rescue|runaway|crash_|launch_control|arm|stats_)/, 'safety', 'Failsafe and arming'],
  [/^(rx_|serialrx_|rc_|rssi_|sbus_|crsf_|elrs_|expresslrs_|spektrum_|max_aux|deadband|yaw_deadband|mid_rc|min_check|max_check|fpv_mix|input_filter|rcinterp|airmode)/, 'receiver', 'Receiver'],
  [/^(gps_)/, 'gps', 'GPS'],
  [/^(mag_|align_mag)/, 'compass', 'Compass'],
  [/^(osd_|displayport_|debug_mode)/, 'osd', 'OSD'],
  [/^(vtx_|vcd_|camera_|rcdevice_)/, 'vtx', 'Video'],
  [/^(ledstrip_|led_|beeper_|beacon)/, 'lights', 'Lights and beeper'],
  [/^(blackbox_|sdcard_|flash_|sdio_)/, 'logging', 'Blackbox'],
  [/^(serial|msp_|usb_|tlm_|frsky_|hott_|ibus_|telemetry_|mavlink_|i2c_|spi_|uart)/, 'ports', 'Ports'],
  [/^(gyro_|acc_|baro_|align_|board_|system_|cpu_|craft_name|pilot_name|name|scheduler_|imu_|altitude_|position_|hw_|pwr_on|reboot_)/, 'fc', 'Flight controller'],
];
export function partOf(name: string): { part: PartId; group: string } {
  for (const [pattern, part, group] of PARTS) if (pattern.test(name)) return { part, group };
  return { part: 'other', group: 'Other' };
}
export const BETAFLIGHT_FEATURED: Record<string, string[]> = {
  motors: ['motor_pwm_protocol', 'dshot_bidir', 'motor_poles', 'dshot_idle_value', 'yaw_motors_reversed'],
  battery: ['battery_meter', 'vbat_max_cell_voltage', 'vbat_warning_cell_voltage', 'vbat_min_cell_voltage', 'bat_capacity', 'current_meter'],
  receiver: ['serialrx_provider', 'rssi_channel', 'rc_smoothing', 'failsafe_procedure'],
  gps: ['gps_provider', 'gps_auto_config', 'gps_ublox_use_galileo'],
  compass: ['mag_hardware'],
  tuning: ['p_roll', 'i_roll', 'd_roll', 'f_roll', 'p_pitch', 'i_pitch', 'd_pitch', 'f_pitch', 'p_yaw', 'i_yaw', 'gyro_lpf1_static_hz', 'dterm_lpf1_static_hz'],
  safety: ['failsafe_procedure', 'failsafe_delay', 'small_angle', 'auto_disarm_delay'],
  fc: ['align_board_roll', 'align_board_pitch', 'align_board_yaw', 'acc_hardware', 'baro_hardware', 'pid_process_denom'],
  vtx: ['vtxtable', 'vtx_band', 'vtx_channel', 'vtx_power', 'vtx_freq'], osd: ['vcd_video_system', 'osd_units', 'osd_canvas_width', 'osd_canvas_height'], lights: ['beeper_dshot_beacon_tone'],
};
const TITLES: Record<string, string> = {
  motor_pwm_protocol: 'Motor protocol', dshot_bidir: 'Bidirectional DShot', motor_poles: 'Motor poles', dshot_idle_value: 'Idle', yaw_motors_reversed: 'Props out', vbat_max_cell_voltage: 'Cell full', vbat_min_cell_voltage: 'Cell empty', vbat_warning_cell_voltage: 'Cell warning', bat_capacity: 'Capacity', battery_meter: 'Voltage source', current_meter: 'Current source', serialrx_provider: 'Receiver protocol', failsafe_procedure: 'Failsafe action', failsafe_delay: 'Failsafe delay', small_angle: 'Max arm angle', auto_disarm_delay: 'Auto disarm', p_roll: 'Roll P', i_roll: 'Roll I', d_roll: 'Roll D', f_roll: 'Roll F', p_pitch: 'Pitch P', i_pitch: 'Pitch I', d_pitch: 'Pitch D', f_pitch: 'Pitch F', p_yaw: 'Yaw P', i_yaw: 'Yaw I', gyro_lpf1_static_hz: 'Gyro filter', dterm_lpf1_static_hz: 'D-term filter', vtx_band: 'Video band', vtx_channel: 'Video channel', vtx_power: 'Video power', vtx_freq: 'Video frequency', gps_provider: 'GPS protocol', rssi_channel: 'Signal channel', rc_smoothing: 'Stick smoothing', osd_units: 'Units', osd_warn_bitmask: 'Warnings shown', osd_canvas_width: 'HD canvas width', osd_canvas_height: 'HD canvas height', vcd_video_system: 'Video system', blackbox_device: 'Log storage', blackbox_sample_rate: 'Log rate', gps_auto_config: 'GPS auto setup', gps_ublox_use_galileo: 'Galileo satellites', mag_hardware: 'Compass', acc_hardware: 'Accelerometer', baro_hardware: 'Barometer', pid_process_denom: 'PID loop divider', anti_gravity_gain: 'Anti-gravity', tpa_rate: 'TPA rate', tpa_breakpoint: 'TPA breakpoint', rates_type: 'Rates type', thr_mid: 'Throttle mid', thr_expo: 'Throttle expo', roll_rc_rate: 'Roll rate', roll_srate: 'Roll super rate', roll_expo: 'Roll expo', pitch_rc_rate: 'Pitch rate', pitch_srate: 'Pitch super rate', yaw_rc_rate: 'Yaw rate', yaw_srate: 'Yaw super rate', failsafe_throttle: 'Failsafe throttle', min_check: 'Stick low', max_check: 'Stick high', min_command: 'Motor stop value', vbat_scale: 'Voltage scale', airmode_start_throttle_percent: 'Air mode start', beeper_dshot_beacon_tone: 'Beacon tone', ledstrip_visual_beeper: 'LED beeper', align_board_roll: 'Board roll', align_board_pitch: 'Board pitch', align_board_yaw: 'Board yaw', craft_name: 'Craft name',
};
const UNITS: [RegExp, string][] = [[/_hz$/, 'Hz'], [/cell_voltage$/, '×0.01 V'], [/^bat_capacity$/, 'mAh'], [/^small_angle$/, '°'], [/^align_board_/, '°'], [/_delay$/, '×0.1 s']];

/** Build a setting from a dump value, refined by `get` details when they are known. */
export function toSetting(name: string, value: string, scope: string | undefined, info: GetInfo | undefined, at: number): Setting {
  const { part, group } = partOf(name);
  const numeric = /^-?\d+(\.\d+)?$/.test(value);
  const options = info?.options ?? (value === 'ON' || value === 'OFF' ? ['OFF', 'ON'] : undefined);
  const type: Setting['type'] = options ? (options.length === 2 && options.includes('ON') && options.includes('OFF') ? 'bool' : 'enum') : numeric && !info?.array ? 'number' : 'text';
  return {
    id: `bf.${name}`, name, part, group, scope, at, type, title: TITLES[name],
    value: type === 'number' ? Number(value) : value,
    options: options?.map(o => ({ value: o, label: o })), min: info?.min, max: info?.max, step: type === 'number' ? 1 : undefined,
    default: info?.default, unit: UNITS.find(([p]) => p.test(name))?.[1], rebootRequired: false,
  };
}

/** Commands that appear in a genuine `diff all` backup. Restore replays only these. */
const RESTORE_OK = /^(set \w+ = [A-Za-z0-9 _.,:+\-]*|feature -?\w+|serial \S+ [\d ]+|aux [\d ]+|map \w+|beeper -?\w+|beacon -?\w+|led \d+ [\w,:]+|color \d+ [\d,]+|mode_color [\d ]+|adjrange [\d ]+|rxrange [\d ]+|rxfail \d+ \w( \d+)?|vtx [\d ]+|vtxtable [\w ]+|profile \d|rateprofile \d|mixer \w+|mmix [\d. \-]+|smix [\d \-]+|servo [\d \-]+|resource \w+ \d+ \w+|timer \w+ AF\d+|dma \w+ \d+ \d+|board_name \w+|manufacturer_id \w+|mcu_id \w+|signature \w*|name [\w \-]+|defaults nosave|batch (start|end))$/i;
export function restoreLines(text: string): { lines: string[]; rejected: string[] } {
  const lines: string[] = [], rejected: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (RESTORE_OK.test(line) && !/^(batch|defaults)/i.test(line)) lines.push(line);
    else if (!/^(batch|defaults)/i.test(line)) rejected.push(line);
  }
  return { lines, rejected };
}

export const ARMING_FLAGS = ['NOGYRO', 'FAILSAFE', 'RXLOSS', 'NOT_DISARMED', 'BOXFAILSAFE', 'RUNAWAY', 'CRASH', 'THROTTLE', 'ANGLE', 'BOOTGRACE', 'NOPREARM', 'LOAD', 'CALIB', 'CLI', 'CMS', 'BST', 'MSP', 'PARALYZE', 'GPS', 'RESCUE_SW', 'RPMFILTER', 'REBOOT_REQD', 'DSHOT_BBANG', 'NO_ACC_CAL', 'MOTOR_PROTO', 'ARMSWITCH'];
export const ARMING_WORDS: Record<string, string> = {
  NOGYRO: 'No gyro detected', FAILSAFE: 'Failsafe is active', RXLOSS: 'No signal from the receiver', NOT_DISARMED: 'Arm switch was on at power-up', BOXFAILSAFE: 'Failsafe switch is on',
  RUNAWAY: 'Runaway takeoff was triggered', CRASH: 'Crash recovery was triggered', THROTTLE: 'Throttle is not at minimum', ANGLE: 'The aircraft is not level enough', BOOTGRACE: 'Still starting up',
  NOPREARM: 'Prearm switch is not on', LOAD: 'Processor load is too high', CALIB: 'Sensors are calibrating', CMS: 'OSD menu is open', PARALYZE: 'Paralyze mode is on', GPS: 'Waiting for GPS fix',
  RESCUE_SW: 'GPS rescue switch is on', RPMFILTER: 'RPM filter has no telemetry from the ESCs', REBOOT_REQD: 'A restart is needed', DSHOT_BBANG: 'DShot bitbang is not working',
  NO_ACC_CAL: 'Accelerometer is not calibrated', MOTOR_PROTO: 'Motor protocol is not set', ARMSWITCH: 'Arm switch is on',
};
/** These two appear whenever a configurator is connected. They are not faults. */
export const ARMING_EXPECTED = new Set(['CLI', 'MSP']);
