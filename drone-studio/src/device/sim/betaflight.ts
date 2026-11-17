import { fromAscii, latin1, Reader, Writer } from '../bytes';
import { encodeMsp, encodeMspV2, MSP, MspParser } from '../msp/codec';
import type { LoopbackEnd } from '../transport';
import { EscBank } from './esc';
import { syntheticBlackbox } from '../blackbox/encode';

/**
 * A simulated Betaflight flight controller: MSP for live data, a text console for settings, ESC passthrough,
 * and a restart on `save`. It is the demo aircraft and the test fixture. Not a flight simulator.
 */
type Def = { value: string; min?: number; max?: number; options?: string[]; scope?: 'profile' | 'rateprofile' };
const num = (value: number, min: number, max: number, scope?: Def['scope']): Def => ({ value: String(value), min, max, scope });
const pick = (value: string, options: string[], scope?: Def['scope']): Def => ({ value, options, scope });
const flag = (on: boolean): Def => ({ value: on ? 'ON' : 'OFF', options: ['OFF', 'ON'] });
export const BETAFLIGHT_SETTINGS: Record<string, Def> = {
  gyro_lpf1_static_hz: num(250, 0, 1000), gyro_lpf2_static_hz: num(500, 0, 1000), dyn_notch_count: num(3, 0, 5), dyn_notch_q: num(300, 1, 1000),
  acc_hardware: pick('AUTO', ['AUTO', 'NONE', 'MPU6000', 'BMI270', 'ICM42688P']), baro_hardware: pick('AUTO', ['AUTO', 'NONE', 'BMP280', 'DPS310']),
  mag_hardware: pick('NONE', ['AUTO', 'NONE', 'HMC5883', 'QMC5883']), align_board_roll: num(0, -180, 360), align_board_pitch: num(0, -180, 360), align_board_yaw: num(0, -180, 360),
  serialrx_provider: pick('CRSF', ['SPEK1024', 'SPEK2048', 'SBUS', 'SUMD', 'IBUS', 'CRSF', 'FPORT', 'GHST']), rssi_channel: num(0, 0, 18), rc_smoothing: flag(true),
  min_check: num(1050, 750, 2250), max_check: num(1900, 750, 2250), airmode_start_throttle_percent: num(25, 0, 100),
  motor_pwm_protocol: pick('DSHOT600', ['PWM', 'ONESHOT125', 'ONESHOT42', 'MULTISHOT', 'BRUSHED', 'DSHOT150', 'DSHOT300', 'DSHOT600', 'PROSHOT1000', 'DISABLED']),
  dshot_bidir: flag(true), dshot_idle_value: num(550, 0, 2000), motor_poles: num(14, 4, 255), yaw_motors_reversed: flag(false), min_command: num(1000, 750, 2250),
  battery_meter: pick('ADC', ['NONE', 'ADC', 'ESC']), current_meter: pick('ADC', ['NONE', 'ADC', 'VIRTUAL', 'ESC', 'MSP']), bat_capacity: num(1300, 0, 20000),
  vbat_max_cell_voltage: num(430, 100, 500), vbat_min_cell_voltage: num(330, 100, 500), vbat_warning_cell_voltage: num(350, 100, 500), vbat_scale: num(110, 0, 255),
  failsafe_procedure: pick('DROP', ['AUTO-LANDING', 'DROP', 'GPS-RESCUE']), failsafe_delay: num(15, 1, 200), failsafe_throttle: num(1000, 750, 2250),
  small_angle: num(25, 0, 180), auto_disarm_delay: num(5, 0, 60), gps_provider: pick('UBLOX', ['NMEA', 'UBLOX', 'MSP']), gps_auto_config: flag(true), gps_ublox_use_galileo: flag(false),
  blackbox_device: pick('SPIFLASH', ['NONE', 'SPIFLASH', 'SDCARD', 'SERIAL']), blackbox_sample_rate: pick('1/2', ['1/1', '1/2', '1/4', '1/8', '1/16']),
  osd_units: pick('METRIC', ['IMPERIAL', 'METRIC', 'BRITISH']), osd_warn_bitmask: num(8191, 0, 4294967295), vtx_band: num(5, 0, 8), vtx_channel: num(8, 0, 8), vtx_power: num(2, 0, 7), vtx_freq: num(5917, 0, 5999),
  beeper_dshot_beacon_tone: num(1, 1, 5), ledstrip_visual_beeper: flag(false), pid_process_denom: num(2, 1, 16), craft_name: { value: 'DEMO5' },
  p_roll: num(45, 0, 250, 'profile'), i_roll: num(80, 0, 250, 'profile'), d_roll: num(40, 0, 250, 'profile'), f_roll: num(120, 0, 1000, 'profile'),
  p_pitch: num(47, 0, 250, 'profile'), i_pitch: num(84, 0, 250, 'profile'), d_pitch: num(46, 0, 250, 'profile'), f_pitch: num(125, 0, 1000, 'profile'),
  p_yaw: num(45, 0, 250, 'profile'), i_yaw: num(80, 0, 250, 'profile'), dterm_lpf1_static_hz: num(75, 0, 1000, 'profile'), anti_gravity_gain: num(80, 0, 250, 'profile'),
  tpa_rate: num(65, 0, 100, 'profile'), tpa_breakpoint: num(1350, 1000, 2000, 'profile'),
  rates_type: pick('ACTUAL', ['BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK'], 'rateprofile'), roll_rc_rate: num(7, 1, 255, 'rateprofile'), roll_expo: num(0, 0, 100, 'rateprofile'),
  roll_srate: num(67, 0, 255, 'rateprofile'), pitch_rc_rate: num(7, 1, 255, 'rateprofile'), pitch_srate: num(67, 0, 255, 'rateprofile'), yaw_rc_rate: num(7, 1, 255, 'rateprofile'),
  yaw_srate: num(67, 0, 255, 'rateprofile'), thr_mid: num(50, 0, 100, 'rateprofile'), thr_expo: num(0, 0, 100, 'rateprofile'),
};
const FEATURES = ['RX_PPM', 'INFLIGHT_ACC_CAL', 'RX_SERIAL', 'MOTOR_STOP', 'SERVO_TILT', 'SOFTSERIAL', 'GPS', 'RANGEFINDER', 'TELEMETRY', '3D', 'RX_PARALLEL_PWM', 'RX_MSP', 'RSSI_ADC', 'LED_STRIP', 'DISPLAY', 'OSD', 'CHANNEL_FORWARDING', 'TRANSPONDER', 'AIRMODE', 'RX_SPI', 'ESC_SENSOR', 'ANTI_GRAVITY'];

export interface BetaflightSimOptions {
  battery?: number; rxLoss?: boolean; escDirections?: number[];
  /** Firmware older than 4.5 restarts when the console is left, even without saving. */
  rebootOnExit?: boolean;
  version?: [number, number, number];
  emptyFlash?: boolean;
}

export class BetaflightSim {
  settings: Record<string, Def> = structuredClone(BETAFLIGHT_SETTINGS);
  /** What is stored in flash. `save` copies the live settings here; a restart copies them back. */
  private saved: { settings: Record<string, Def>; features: string[]; serial: Record<string, string>; aux: Record<string, string>; map: string; vtx: string[] };
  features = new Set(['RX_SERIAL', 'TELEMETRY', 'OSD', 'AIRMODE', 'ANTI_GRAVITY', 'GPS']);
  serial: Record<string, string> = { '0': '1 115200 57600 0 115200', '1': '64 115200 57600 0 115200', '2': '2 115200 57600 0 115200', '5': '1024 115200 57600 0 115200' };
  aux: Record<string, string> = { '0': '0 0 1700 2100 0 0', '1': '1 1 1300 1700 0 0', '2': '13 2 1700 2100 0 0', '3': '35 3 1700 2100 0 0' };
  map = 'AETR1234';
  vtxTable: string[] = ['vtxtable bands 0', 'vtxtable channels 0', 'vtxtable powerlevels 0', 'vtxtable powervalues', 'vtxtable powerlabels'];
  escBank: EscBank;
  armed = false;
  battery: number;
  rxLoss: boolean;
  motors = Array(8).fill(1000) as number[];
  /** Every motor command received, for assertions. */
  motorLog: number[][] = [];
  cliLog: string[] = [];
  reboots = 0;
  inBootloader = false;
  calibrations: string[] = [];
  /** Onboard log flash. Two flights by default: a rough one, then a smooth one. */
  flash: Uint8Array;
  flashTotal = 16 * 1024 * 1024;
  erasing = 0;
  private port?: LoopbackEnd;
  private msp = new MspParser();
  private cli = false;
  private line = '';
  private tick = 0;

  constructor(private options: BetaflightSimOptions = {}) {
    this.battery = options.battery ?? 16.1;
    this.rxLoss = options.rxLoss ?? false;
    this.escBank = new EscBank('BTFL', ['BLHeli_S', 'BLHeli_S', 'BLHeli_S', 'BLHeli_S'], options.escDirections ?? [1, 2, 1, 1]);
    this.saved = this.snapshot();
    const a = syntheticBlackbox(4, 1), b = syntheticBlackbox(3, 0.2);
    this.flash = options.emptyFlash ? new Uint8Array(0) : Uint8Array.from([...a, ...b]);
  }
  private snapshot() { return { settings: structuredClone(this.settings), features: [...this.features], serial: { ...this.serial }, aux: { ...this.aux }, map: this.map, vtx: [...this.vtxTable] }; }
  /** Plug the (re)started flight controller into a port. */
  attach(port: LoopbackEnd) {
    this.port = port; this.cli = false; this.line = ''; this.msp = new MspParser(); this.escBank.active = false;
    port.onData(chunk => this.receive(chunk));
  }
  private write(bytes: Uint8Array) { if (this.port?.open) void this.port.write(bytes).catch(() => {}); }
  private print(text: string) { this.write(fromAscii(text.replace(/\n/g, '\r\n'))); }
  private reboot() {
    this.reboots++;
    this.settings = structuredClone(this.saved.settings); this.features = new Set(this.saved.features);
    this.serial = { ...this.saved.serial }; this.aux = { ...this.saved.aux }; this.map = this.saved.map; this.vtxTable = [...this.saved.vtx];
    this.motors.fill(1000);
    const port = this.port; this.port = undefined;
    setTimeout(() => port?.drop('device restarted'), 5);
  }
  private receive(chunk: Uint8Array) {
    if (this.inBootloader) return;
    if (this.escBank.active) { const reply = this.escBank.handle(chunk); if (reply?.length) this.write(reply); return; }
    if (this.cli) return this.console(latin1(chunk));
    if (chunk.length === 1 && chunk[0] === 0x23) { this.cli = true; this.print('\nEntering CLI Mode, type \'exit\' to return, or \'help\'\n\n# '); return; }
    for (const frame of this.msp.push(chunk)) if (frame.direction === '<') this.request(frame.command, frame.payload);
  }
  private reply(command: number, payload: Uint8Array = new Uint8Array(0)) { this.write(encodeMsp(command, payload, '>')); }
  private request(command: number, payload: Uint8Array) {
    const w = new Writer();
    const [major, minor, patch] = this.options.version ?? [4, 5, 1];
    switch (command) {
      case MSP.API_VERSION: return this.reply(command, Uint8Array.of(0, 1, 46));
      case MSP.FC_VARIANT: return this.reply(command, fromAscii('BTFL'));
      case MSP.FC_VERSION: return this.reply(command, Uint8Array.of(major, minor, patch));
      case MSP.BOARD_INFO: { const name = fromAscii('SPEEDYBEEF405V4'); return this.reply(command, w.bytes(fromAscii('S405')).u16(0).u8(2).u8(0).u8(9).bytes(fromAscii('STM32F405')).u8(name.length).bytes(name).done()); }
      case MSP.NAME: return this.reply(command, fromAscii(this.settings.craft_name.value));
      case MSP.UID: return this.reply(command, w.u32(0x00320028).u32(0x33385114).u32(0x39363532).done());
      case MSP.MIXER_CONFIG: return this.reply(command, Uint8Array.of(3, this.settings.yaw_motors_reversed.value === 'ON' ? 1 : 0));
      case MSP.MOTOR_CONFIG: return this.reply(command, w.u16(1070).u16(2000).u16(1000).u8(4).u8(14).u8(1).u8(0).done());
      case MSP.FEATURE_CONFIG: { let mask = 0; FEATURES.forEach((f, i) => { if (this.features.has(f)) mask |= 1 << [0, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 25, 27, 28][i]; }); return this.reply(command, w.u32(mask >>> 0).done()); }
      case MSP.ATTITUDE: { const s = this.tick++ / 10; return this.reply(command, w.i16(Math.round(12 * Math.sin(s / 2))).i16(Math.round(8 * Math.cos(s / 3))).i16(69).done()); }
      case MSP.STATUS_EX: {
        const disable = (this.rxLoss ? 1 << 2 : 0) | (this.cli ? 1 << 13 : 0) | (1 << 16);
        return this.reply(command, w.u16(125).u16(0).u16(1 | 2 | 8 | 32).u32(this.armed ? 1 : 0).u8(0).u16(14).u8(3).u8(0).u8(0).u8(26).u32(disable >>> 0).u8(0).done());
      }
      case MSP.BATTERY_STATE: return this.reply(command, w.u8(this.battery > 2 ? 4 : 0).u16(1300).u8(Math.round(this.battery * 10)).u16(210).u16(140).u8(0).u16(Math.round(this.battery * 100)).done());
      case MSP.ANALOG: return this.reply(command, w.u8(Math.round(this.battery * 10)).u16(210).u16(900).i16(140).u16(Math.round(this.battery * 100)).done());
      case MSP.RC: { for (const v of [1500, 1500, 1500, 1000, 1300, 1000, 1000, 1000]) w.u16(v); return this.reply(command, w.done()); }
      case MSP.MOTOR: { for (const v of this.motors) w.u16(v); return this.reply(command, w.done()); }
      case MSP.RAW_GPS: return this.reply(command, w.u8(1).u8(12).u32(377749000).u32((-1224194000) >>> 0).u16(12).u16(0).u16(0).u16(110).done());
      case MSP.SET_MOTOR: {
        if (this.armed) return this.write(encodeMsp(command, new Uint8Array(0), '!'));
        const r = new Reader(payload); this.motors = Array.from({ length: 8 }, () => r.left >= 2 ? r.u16() : 1000); this.motorLog.push([...this.motors]);
        return this.reply(command);
      }
      case MSP.DATAFLASH_SUMMARY: return this.reply(command, w.u8(this.erasing > 0 ? 2 : 3).u32(4096).u32(this.flashTotal).u32(this.erasing > 0 ? 0 : this.flash.length).done());
      case MSP.DATAFLASH_READ: {
        const r = new Reader(payload), address = r.u32(), size = r.left >= 2 ? r.u16() : 128;
        const data = this.flash.subarray(address, Math.min(this.flash.length, address + size));
        const body = w.u32(address).u16(data.length).u8(0).bytes(data).done();
        return this.write(body.length > 254 ? encodeMspV2(command, body, '>') : encodeMsp(command, body, '>'));
      }
      case MSP.DATAFLASH_ERASE: this.erasing = 3; this.flash = new Uint8Array(0); setTimeout(() => { this.erasing = 0; }, 30); return this.reply(command);
      case MSP.ACC_CALIBRATION: this.calibrations.push('accel'); return this.reply(command);
      case MSP.MAG_CALIBRATION: this.calibrations.push('compass'); return this.reply(command);
      case MSP.SET_PASSTHROUGH: { const reply = this.escBank.handle(encodeMsp(245)); if (reply) this.write(reply); return; }
      case MSP.REBOOT: this.reply(command, payload); if (payload[0] === 1) { this.inBootloader = true; const port = this.port; setTimeout(() => port?.drop('device entered bootloader'), 5); } else this.reboot(); return;
      default: return this.write(encodeMsp(command, new Uint8Array(0), '!'));
    }
  }
  private console(text: string) {
    this.line += text;
    let at: number;
    while ((at = this.line.indexOf('\n')) >= 0) {
      const command = this.line.slice(0, at).replace(/\r/g, '').trim();
      this.line = this.line.slice(at + 1);
      this.cliLog.push(command);
      const out = this.execute(command);
      if (out === null) return;
      this.print(`${command}\n${out}${out ? '\n' : ''}\n# `);
    }
  }
  private describe(name: string): string {
    const d = this.settings[name];
    const head = d.scope ? `${d.scope} 0\n` : '';
    const allowed = d.options ? `Allowed values: ${d.options.join(', ')}` : d.min !== undefined ? `Allowed range: ${d.min} - ${d.max}` : 'Array length: 16';
    return `${head}${name} = ${d.value}\n${allowed}\nDefault value: ${BETAFLIGHT_SETTINGS[name].value}\n`;
  }
  private dump(diff: boolean): string {
    const lines = ['', '# version', '# Betaflight / STM32F405 (S405) 4.5.1 Oct 10 2024 / 03:21:04 (77d01ba3b) MSP API: 1.46', '', '# start the command batch', 'batch start', '', 'board_name SPEEDYBEEF405V4', 'manufacturer_id SPBE', '', '# feature'];
    for (const f of FEATURES) if (this.features.has(f) || !diff) lines.push(`feature ${this.features.has(f) ? '' : '-'}${f}`);
    lines.push('', '# serial', ...Object.entries(this.serial).map(([id, v]) => `serial ${id} ${v}`), '', '# aux', ...Object.entries(this.aux).map(([id, v]) => `aux ${id} ${v}`), '', `map ${this.map}`, '', '# master');
    const changed = (name: string) => !diff || this.settings[name].value !== BETAFLIGHT_SETTINGS[name].value;
    const of = (scope?: string) => Object.entries(this.settings).filter(([name, d]) => d.scope === scope && changed(name)).map(([name, d]) => `set ${name} = ${d.value}`);
    lines.push(...of(undefined), '', 'profile 0', '', '# profile 0', ...of('profile'), '', 'rateprofile 0', '', '# rateprofile 0', ...of('rateprofile'), '', '# end the command batch', 'batch end', '');
    return lines.join('\n');
  }
  private execute(command: string): string | null {
    let m: RegExpMatchArray | null;
    if (command === 'dump' || command === 'dump all') return this.dump(false);
    if (command === 'diff' || command === 'diff all') return this.dump(true);
    if (command === 'feature') return `Enabled: ${[...this.features].join(' ')}`;
    if (command === 'feature list') return `Available: ${FEATURES.join(' ')}`;
    if ((m = command.match(/^feature (-?)(\w+)$/))) {
      if (!FEATURES.includes(m[2])) return `###ERROR IN feature: INVALID NAME: ${m[2]}###`;
      if (m[1]) this.features.delete(m[2]); else this.features.add(m[2]);
      return `${m[1] ? 'Disabled' : 'Enabled'} ${m[2]}`;
    }
    if (command === 'serial') return Object.entries(this.serial).map(([id, v]) => `serial ${id} ${v}`).join('\n');
    if ((m = command.match(/^serial (\S+) ([\d ]+)$/))) { if (!(m[1] in this.serial)) return '###ERROR IN serial: INVALID PORT###'; this.serial[m[1]] = m[2].trim(); return ''; }
    if (command === 'aux') return Object.entries(this.aux).map(([id, v]) => `aux ${id} ${v}`).join('\n');
    if ((m = command.match(/^aux (\d+) ([\d ]+)$/))) { this.aux[m[1]] = m[2].trim(); return ''; }
    if (command === 'map') return `map ${this.map}`;
    if ((m = command.match(/^map ([A-Z]{4}\d{4})$/))) { this.map = m[1]; return `map ${this.map}`; }
    if ((m = command.match(/^get ?(\w*)$/))) {
      const hits = Object.keys(this.settings).filter(name => name.includes(m![1]));
      return hits.length ? hits.map(name => this.describe(name)).join('\n') : `###ERROR IN get: INVALID NAME: ${m[1]}###`;
    }
    if ((m = command.match(/^set (\w+) = (.*)$/))) {
      const d = this.settings[m[1]], value = m[2].trim();
      if (!d) return `###ERROR IN set: INVALID NAME: ${m[1]}###`;
      if (d.options) { const hit = d.options.find(o => o.toLowerCase() === value.toLowerCase()); if (!hit) return `###ERROR IN set: INVALID VALUE###\nAllowed values: ${d.options.join(', ')}`; d.value = hit; }
      else if (d.min !== undefined) { const n = Number(value); if (!Number.isInteger(n) || n < d.min || n > d.max!) return `###ERROR IN set: INVALID VALUE RANGE###\nAllowed range: ${d.min} - ${d.max}`; d.value = String(n); }
      else d.value = value;
      return `${m[1]} set to ${d.value}`;
    }
    if (command === 'vtxtable') {
      const rank = (l: string) => ['vtxtable bands', 'vtxtable channels', 'vtxtable band ', 'vtxtable powerlevels', 'vtxtable powervalues', 'vtxtable powerlabels'].findIndex(p => l.startsWith(p));
      return [...this.vtxTable].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).join('\n');
    }
    if ((m = command.match(/^vtxtable (bands|channels|powerlevels) (\d+)$/))) {
      const n = Number(m[2]);
      if (n > 8) return '###ERROR IN vtxtable: INVALID VALUE###';
      const key = `vtxtable ${m[1]} `;
      this.vtxTable = [...this.vtxTable.filter(l => !l.startsWith(key)), `${key}${n}`];
      if (m[1] === 'bands') this.vtxTable = this.vtxTable.filter(l => !/^vtxtable band \d+ /.test(l) || Number(l.split(' ')[2]) <= n);
      return '';
    }
    if ((m = command.match(/^vtxtable band (\d) ([A-Z0-9_]+) ([A-Z0-9]) (FACTORY|CUSTOM)((?: \d+)+)$/))) {
      this.vtxTable = [...this.vtxTable.filter(l => !l.startsWith(`vtxtable band ${m![1]} `)), command];
      return '';
    }
    if ((m = command.match(/^vtxtable (powervalues|powerlabels)((?: \w+)*)$/))) { this.vtxTable = [...this.vtxTable.filter(l => !l.startsWith(`vtxtable ${m![1]}`)), command]; return ''; }
    if (command === 'profile 0' || command === 'rateprofile 0') return command;
    if (command === 'save') { this.saved = this.snapshot(); this.print('save\nSaving\nRebooting'); this.reboot(); return null; }
    if (command === 'exit' || command === 'exit noreboot') {
      this.settings = structuredClone(this.saved.settings); this.features = new Set(this.saved.features);
      this.serial = { ...this.saved.serial }; this.aux = { ...this.saved.aux }; this.map = this.saved.map; this.vtxTable = [...this.saved.vtx];
      if (command === 'exit' || this.options.rebootOnExit) { this.print('Leaving CLI mode, unsaved changes lost.\nRebooting'); this.reboot(); return null; }
      this.cli = false; this.print('exit noreboot\nLeaving CLI mode, unsaved changes lost.\n'); return null;
    }
    return `###ERROR: UNKNOWN COMMAND, try 'HELP'###`;
  }
}
