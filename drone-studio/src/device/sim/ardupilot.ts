import { encode, MavlinkParser, type Fields } from '../mavlink/codec';
import type { MessageName } from '../mavlink/messages';
import type { LoopbackEnd } from '../transport';
import { syntheticLog } from './dataflash';
import { EscBank } from './esc';

/**
 * A simulated ArduCopter that speaks real MAVLink bytes. It is the demo aircraft and the test fixture.
 * It is not a flight simulator: values are plausible, physics are absent.
 */
const INT = 6, I16 = 4, I8 = 2, FLOAT = 9;
type P = [name: string, value: number, type: number];
export const ARDUPILOT_PARAMS: P[] = [
  ['AHRS_ORIENTATION', 0, I8], ['AHRS_TRIM_X', -0.0143, FLOAT], ['AHRS_TRIM_Y', -0.0008, FLOAT], ['ANGLE_MAX', 3000, I16],
  ['ARMING_CHECK', 1, INT], ['ATC_ANG_PIT_P', 4.5, FLOAT], ['ATC_ANG_RLL_P', 4.5, FLOAT], ['ATC_ANG_YAW_P', 4.5, FLOAT],
  ['ATC_RAT_PIT_D', 0.0036, FLOAT], ['ATC_RAT_PIT_I', 0.135, FLOAT], ['ATC_RAT_PIT_P', 0.135, FLOAT],
  ['ATC_RAT_RLL_D', 0.0036, FLOAT], ['ATC_RAT_RLL_I', 0.135, FLOAT], ['ATC_RAT_RLL_P', 0.135, FLOAT],
  ['ATC_RAT_YAW_I', 0.018, FLOAT], ['ATC_RAT_YAW_P', 0.18, FLOAT],
  ['BATT_CAPACITY', 1300, INT], ['BATT_CRT_VOLT', 13.2, FLOAT], ['BATT_FS_CRT_ACT', 1, I8], ['BATT_FS_LOW_ACT', 2, I8],
  ['BATT_LOW_VOLT', 14.0, FLOAT], ['BATT_MONITOR', 4, I8], ['BATT_VOLT_MULT', 11.0, FLOAT],
  ['COMPASS_ENABLE', 1, I8], ['FENCE_ENABLE', 0, I8], ['FLTMODE1', 0, I8], ['FLTMODE2', 2, I8], ['FLTMODE3', 5, I8],
  ['FLTMODE4', 0, I8], ['FLTMODE5', 0, I8], ['FLTMODE6', 9, I8], ['FLTMODE_CH', 5, I8], ['FRAME_CLASS', 1, I8], ['FRAME_TYPE', 12, I8],
  ['FS_GCS_ENABLE', 0, I8], ['FS_THR_ENABLE', 1, I8], ['FS_THR_VALUE', 975, I16], ['GPS_TYPE', 1, I8],
  ['INS_ACCOFFS_X', 0.012, FLOAT], ['INS_ACCOFFS_Y', -0.02, FLOAT], ['INS_ACCOFFS_Z', 0.05, FLOAT], ['INS_GYRO_FILTER', 40, I16], ['INS_HNTCH_ENABLE', 0, I8],
  ['LOG_BITMASK', 176126, INT], ['LOG_DISARMED', 0, I8], ['MOT_BAT_VOLT_MAX', 16.8, FLOAT], ['MOT_BAT_VOLT_MIN', 13.2, FLOAT],
  ['MOT_PWM_TYPE', 6, I8], ['MOT_SPIN_ARM', 0.1, FLOAT], ['MOT_SPIN_MIN', 0.15, FLOAT], ['RSSI_TYPE', 3, I8], ['RTL_ALT', 1500, INT],
  ['SERIAL0_PROTOCOL', 2, I8], ['SERVO1_FUNCTION', 33, I16], ['SERVO2_FUNCTION', 34, I16], ['SERVO3_FUNCTION', 35, I16], ['SERVO4_FUNCTION', 36, I16],
  ['SERVO_BLH_AUTO', 1, I8], ['SERVO_BLH_PORT', 0, I8], ['SERVO_DSHOT_ESC', 2, I8], ['SYSID_THISMAV', 1, I16],
];

export interface ArdupilotSimOptions {
  /** Indices to withhold from the first parameter stream, to exercise the retry. */
  dropParams?: number[];
  battery?: number;
  /** Reasons the simulated aircraft gives for refusing to arm. */
  prearm?: string[];
  rcPresent?: boolean;
  escDirections?: number[];
  /** Milliseconds between telemetry bursts. */
  tickMs?: number;
  /** How rough the stored flight log is. */
  shake?: number;
  /** Bytes of LOG_DATA to silently drop once, to exercise gap recovery. */
  dropLogChunk?: number;
}

export class ArdupilotSim {
  params = new Map<string, { value: number; type: number }>();
  escBank: EscBank;
  armed = false;
  battery: number;
  prearm: string[];
  rcPresent: boolean;
  /** Commands received, for assertions. */
  commands: { command: number; params: number[] }[] = [];
  motorTests: { motor: number; throttle: number; seconds: number }[] = [];
  /** Timestamp of the last MAVLink frame from the host. */
  lastMavlinkIn = 0;
  log: Uint8Array;
  logRequests = 0;
  private parser = new MavlinkParser();
  private seq = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private dropped = new Set<number>();
  private tick = 0;
  private logDropped = false;
  private magCal?: ReturnType<typeof setInterval>;
  private streaming = true;

  private port!: LoopbackEnd;
  reboots = 0;
  inBootloader = false;
  constructor(port: LoopbackEnd | undefined, private options: ArdupilotSimOptions = {}) {
    for (const [name, value, type] of ARDUPILOT_PARAMS) this.params.set(name, { value: Math.fround(value), type });
    this.battery = options.battery ?? 15.8;
    this.prearm = options.prearm ?? [];
    this.rcPresent = options.rcPresent ?? true;
    this.escBank = new EscBank('ARDU', ['Bluejay', 'Bluejay', 'Bluejay', 'Bluejay'], options.escDirections ?? [1, 1, 2, 1]);
    this.log = syntheticLog(12, options.shake ?? 1);
    for (const i of options.dropParams ?? []) this.dropped.add(i);
    const ms = options.tickMs ?? 100;
    this.timers.push(setInterval(() => this.telemetry(), ms));
    if (port) this.attach(port);
  }
  /** Plug the (re)started flight controller into a port. */
  attach(port: LoopbackEnd) {
    this.port = port; this.parser = new MavlinkParser(); this.escBank.active = false;
    port.onData(chunk => this.receive(chunk));
    this.heartbeat();
  }
  stop() { for (const t of this.timers) clearInterval(t); clearInterval(this.magCal); }
  private send(name: MessageName, fields: Fields) { if (this.port?.open && this.streaming && !this.inBootloader) void this.port.write(encode(name, fields, this.seq++, 1, 1)).catch(() => {}); }
  private text(text: string, severity = 6) { this.send('STATUSTEXT', { severity, text }); }
  private heartbeat() { this.send('HEARTBEAT', { type: 2, autopilot: 3, base_mode: 81 | (this.armed ? 128 : 0), custom_mode: 0, system_status: this.armed ? 4 : 3, mavlink_version: 3 }); }
  private telemetry() {
    const t = this.tick++;
    const s = t / 10;
    if (this.escBank.active) return; // The port belongs to the ESCs.
    if (t % 10 === 0) this.heartbeat();
    this.send('ATTITUDE', { time_boot_ms: t * 100, roll: 0.02 * Math.sin(s / 2) + (this.params.get('AHRS_TRIM_X')!.value + 0.0143), pitch: 0.015 * Math.cos(s / 3), yaw: 1.2, rollspeed: 0, pitchspeed: 0, yawspeed: 0 });
    if (t % 5 === 0) {
      const sensors = 0x01 | 0x02 | 0x04 | 0x08 | 0x20 | 0x10000 | 0x200000 | 0x2000000 | 0x10000000;
      const health = sensors & ~(this.rcPresent ? 0 : 0x10000) & ~(this.prearm.length ? 0x10000000 : 0);
      this.send('SYS_STATUS', { onboard_control_sensors_present: sensors, onboard_control_sensors_enabled: sensors, onboard_control_sensors_health: health, load: 180,
        voltage_battery: Math.round(this.battery * 1000), current_battery: 120, battery_remaining: 76, drop_rate_comm: 0, errors_comm: 0 });
      this.send('SERVO_OUTPUT_RAW', { time_usec: t * 100000, port: 0, servo1_raw: 1000, servo2_raw: 1000, servo3_raw: 1000, servo4_raw: 1000 });
      if (this.rcPresent) this.send('RC_CHANNELS', { time_boot_ms: t * 100, chancount: 8, chan1_raw: 1500, chan2_raw: 1500, chan3_raw: 1000 + Math.round(20 * Math.sin(s)), chan4_raw: 1500, chan5_raw: 1300, chan6_raw: 1000, chan7_raw: 1000, chan8_raw: 1000, rssi: 220 });
      else this.send('RC_CHANNELS', { time_boot_ms: t * 100, chancount: 0, rssi: 255 });
    }
    if (t % 10 === 0) {
      this.send('GPS_RAW_INT', { time_usec: t * 100000, fix_type: 3, lat: 377749000, lon: -1224194000, alt: 12000, eph: 90, epv: 140, vel: 0, cog: 0, satellites_visible: 14 });
      this.send('BATTERY_STATUS', { id: 0, battery_function: 0, type: 1, temperature: 32767, voltages: [3950, 3950, 3950, 3950, 65535, 65535, 65535, 65535, 65535, 65535].map(v => v === 65535 ? v : Math.round((this.battery / 4) * 1000)), current_battery: 120, current_consumed: 310, energy_consumed: -1, battery_remaining: 76 });
      this.send('VIBRATION', { time_usec: t * 100000, vibration_x: 0.4, vibration_y: 0.5, vibration_z: 0.7, clipping_0: 0, clipping_1: 0, clipping_2: 0 });
      this.send('VFR_HUD', { airspeed: 0, groundspeed: 0, heading: 69, throttle: 0, alt: 12.1, climb: 0 });
    }
  }
  private receive(chunk: Uint8Array) {
    if (this.inBootloader) return;
    const esc = this.escBank.handle(chunk);
    if (esc?.length) { void this.port.write(esc); return; }
    for (const p of this.parser.push(chunk)) {
      this.lastMavlinkIn = Date.now();
      const f = p.fields, n = (key: string) => Number(f[key]);
      if (p.name === 'PARAM_REQUEST_LIST') this.streamParams();
      else if (p.name === 'PARAM_REQUEST_READ') {
        const names = [...this.params.keys()];
        const name = n('param_index') >= 0 && n('param_index') < 65535 && !f.param_id ? names[n('param_index')] : String(f.param_id);
        if (this.params.has(name)) this.sendParam(name);
      } else if (p.name === 'PARAM_SET') {
        const name = String(f.param_id), param = this.params.get(name);
        if (!param) continue;
        if (!this.armed) param.value = param.type === FLOAT ? Math.fround(n('param_value')) : Math.trunc(n('param_value'));
        this.sendParam(name);
      } else if (p.name === 'COMMAND_LONG') this.command(n('command'), [1, 2, 3, 4, 5, 6, 7].map(i => n(`param${i}`)));
      else if (p.name === 'LOG_REQUEST_LIST') this.send('LOG_ENTRY', { id: 7, num_logs: 1, last_log_num: 7, time_utc: 1760000000, size: this.log.length });
      else if (p.name === 'LOG_REQUEST_DATA') this.streamLog(n('id'), n('ofs'), n('count'));
    }
  }
  private sendParam(name: string) {
    const names = [...this.params.keys()], param = this.params.get(name)!;
    this.send('PARAM_VALUE', { param_id: name, param_value: param.value, param_type: param.type, param_count: names.length, param_index: names.indexOf(name) });
  }
  private streamParams() {
    const names = [...this.params.keys()];
    names.forEach((name, i) => { if (this.dropped.has(i)) this.dropped.delete(i); else this.sendParam(name); });
  }
  private streamLog(id: number, ofs: number, count: number) {
    this.logRequests++;
    if (id !== 7) return;
    for (let at = ofs; at < Math.min(this.log.length, ofs + count); at += 90) {
      const chunk = this.log.subarray(at, Math.min(at + 90, this.log.length));
      if (this.options.dropLogChunk === at && !this.logDropped) { this.logDropped = true; continue; }
      const data = new Array(90).fill(0);
      chunk.forEach((b, i) => { data[i] = b; });
      this.send('LOG_DATA', { id, ofs: at, count: chunk.length, data });
    }
  }
  private ack(command: number, result = 0) { this.send('COMMAND_ACK', { command, result }); }
  private command(command: number, p: number[]) {
    this.commands.push({ command, params: p });
    switch (command) {
      case 511: return this.ack(command);
      case 512:
        this.ack(command);
        if (p[0] === 148) this.send('AUTOPILOT_VERSION', { capabilities: 0xf1ef, flight_sw_version: (4 << 24) | (5 << 16) | (7 << 8) | 255, board_version: 1151 << 16, vendor_id: 0x1209, product_id: 0x5741, uid: 0n, uid2: [0x35, 0, 0x2c, 0, 0x0c, 0x51, 0x33, 0x34, 0x38, 0x36, 0x35, 0x39, 0, 0, 0, 0, 0, 0] });
        return;
      case 401:
        this.ack(command);
        for (const reason of this.prearm) this.text(`PreArm: ${reason}`, 2);
        return;
      case 241: {
        if (this.armed) return this.ack(command, 4);
        if (p[4] === 2) { const trim = this.params.get('AHRS_TRIM_X')!; trim.value = Math.fround(trim.value + 0.0143); this.text('Trim OK'); }
        else if (p[0] === 1) this.text('Gyro calibrated');
        else if (p[2] === 1) this.text('Barometer calibration complete');
        else if (p[4] === 4) this.text('Calibration successful');
        return this.ack(command);
      }
      case 209: {
        if (this.armed) return this.ack(command, 4);
        if (p[2] > 0) this.motorTests.push({ motor: p[0], throttle: p[2], seconds: p[3] });
        return this.ack(command);
      }
      case 246: {
        this.ack(command);
        this.reboots++;
        if (p[0] === 3) this.inBootloader = true;
        const port = this.port;
        setTimeout(() => port.drop(p[0] === 3 ? 'device entered bootloader' : 'device restarted'), 5);
        return;
      }
      case 42424: {
        this.ack(command);
        let pct = 0;
        this.magCal = setInterval(() => {
          pct += 25;
          if (pct < 100) this.send('MAG_CAL_PROGRESS', { compass_id: 0, cal_mask: 1, cal_status: 3, attempt: 1, completion_pct: pct, completion_mask: [], direction_x: 0, direction_y: 0, direction_z: 0 });
          else { clearInterval(this.magCal); this.send('MAG_CAL_REPORT', { compass_id: 0, cal_mask: 1, cal_status: 4, autosaved: 1, fitness: 9.6, ofs_x: 31.5, ofs_y: -12.25, ofs_z: 88, diag_x: 1, diag_y: 1, diag_z: 1, offdiag_x: 0, offdiag_y: 0, offdiag_z: 0 }); }
        }, this.options.tickMs ?? 100);
        return;
      }
      case 400: return this.ack(command, 2); // Arming is never offered by Lucidity; refuse it here too.
      default: return this.ack(command, 3);
    }
  }
}
