import { analyzeDataFlash, type FlightLogAnalysis } from '../../aircraft/dataflash-analysis';
import { ardupilotFrame, px4Frame } from '../airframe';
import { ascii, deferred, DeviceError, f32, round, sleep, view } from '../bytes';
import { escSettings, ESC_TIMING, FourWay, type EscRead, type EscTiming } from '../esc/fourway';
import { flashEscs, readAllEscs, writeEscChanges, type EscSession } from '../esc/session';
import type { ByteTransport } from '../transport';
import {
  DriverBase, type Airframe, type Change, type ChangeResult, type Condition, type Driver, type EscInfo, type Health, type Identity,
  type LiveState, type LogEntry, type RunContext, type Setting, type SettingValue, type TestResult, type TestSpec, type Vehicle,
} from '../types';
import { encode, MavlinkParser, type Fields, type Packet } from './codec';
import type { MessageName } from './messages';
import { ARDUPILOT_META, modeName, partOf, PREARM_BIT, RESULT, SENSOR_BITS } from './meta';

/**
 * ArduPilot and PX4 over MAVLink. Behaviour follows the bench-tested src/aircraft/service.ts where that exists:
 * no ground-station heartbeat except during log transfer, one parameter write at a time with a fresh readback,
 * and ESC passthrough only after the link has been quiet for four seconds.
 */
export interface MavTiming { heartbeatMs: number; ackMs: number; paramIdleMs: number; echoMs: number; quietMs: number; restoreMs: number; logIdleMs: number; esc: EscTiming }
export const MAV_TIMING: MavTiming = { heartbeatMs: 6000, ackMs: 3000, paramIdleMs: 1200, echoMs: 1500, quietMs: 4100, restoreMs: 8000, logIdleMs: 700, esc: ESC_TIMING };

interface Param { value: number; type: number; index: number; at: number }
type Meta = (typeof ARDUPILOT_META)[string];
const STREAMS: [id: number, hz: number][] = [[30, 10], [1, 2], [24, 1], [65, 5], [36, 5], [147, 1], [74, 2], [193, 1], [241, 2], [11030, 2], [33, 2]];
const VEHICLES: Record<number, Vehicle> = { 1: 'plane', 2: 'quad', 3: 'quad', 4: 'heli', 10: 'rover', 11: 'rover', 13: 'hex', 14: 'octo', 15: 'tri' };
const FIRMWARE: Partial<Record<Vehicle, string>> = { plane: 'ArduPlane', rover: 'Rover' };
const LOG_WINDOW = 90 * 64, LOG_MAX = 64 * 1024 * 1024;

export function requireGrant(ctx: RunContext, operation: string, needs: readonly Condition[]) {
  if (!ctx.grant) throw new DeviceError('not_approved', 'This needs approval from the person at the aircraft.', 'Use propose_change or run_test and wait for approval in Lucidity.');
  if (ctx.grant.operation !== operation) throw new DeviceError('not_approved', 'The approval was given for a different operation.');
  const missing = needs.filter(n => !ctx.grant!.conditions.includes(n));
  if (missing.length) throw new DeviceError('not_approved', `Not confirmed at the aircraft: ${missing.join(', ')}.`);
}

export class MavlinkDriver extends DriverBase implements Driver {
  identity: Identity;
  readonly transportLabel: string;
  private parser = new MavlinkParser();
  private seq = 0;
  private target = { sysid: 1, compid: 1 };
  private px4 = false;
  private live: LiveState = { at: 0, linkOk: false, armed: false, mode: 'Unknown', sensors: {}, armingBlocks: [], messages: [] };
  private params = new Map<string, Param>();
  private paramCount?: number;
  private loaded: 'none' | 'loading' | 'partial' | 'complete' = 'none';
  private meta: Record<string, Meta> = { ...ARDUPILOT_META };
  private waiters = new Set<(packet: Packet) => void>();
  private raw = new Set<(bytes: Uint8Array) => void>();
  private quiet = false;
  private escReads: EscRead[] = [];
  private logList: LogEntry[] = [];
  private lastLog?: { id: number; analysis: FlightLogAnalysis };
  private offs: (() => void)[] = [];
  private tick?: ReturnType<typeof setInterval>;
  private lastEmit = 0;
  private closedReason?: string;
  private motorTestUntil = 0;

  private constructor(private transport: ByteTransport, private timing: MavTiming, private now: () => number) {
    super();
    this.transportLabel = transport.label;
    this.identity = { stack: 'ardupilot', firmware: 'ArduCopter', version: 'unknown', vehicle: 'quad' };
    this.offs.push(transport.onData(chunk => this.receive(chunk)), transport.onClose(reason => this.onClosed(reason)));
    this.tick = setInterval(() => this.checkLink(), 1000);
  }

  /** Wait for an autopilot heartbeat, then ask who it is and request telemetry. */
  static async connect(transport: ByteTransport, options: { timing?: Partial<MavTiming>; now?: () => number } = {}): Promise<MavlinkDriver> {
    const driver = new MavlinkDriver(transport, { ...MAV_TIMING, ...options.timing, esc: { ...ESC_TIMING, ...options.timing?.esc } }, options.now ?? Date.now);
    try {
      await driver.waitFor(p => p.name === 'HEARTBEAT' && driver.isAutopilot(p) ? true : undefined, driver.timing.heartbeatMs,
        'No flight controller answered. Check the cable and that this port is the flight controller.');
      await driver.requestStreams();
      return driver;
    } catch (error) { await driver.close(); throw error; }
  }

  // ---- Link ---------------------------------------------------------------------------------------------------

  private isAutopilot(p: Packet) { return p.compid === 1 && Number(p.fields.autopilot) !== 8 && Number(p.fields.type) !== 6; }
  private receive(chunk: Uint8Array) {
    for (const listener of [...this.raw]) listener(chunk);
    for (const packet of this.parser.push(chunk)) {
      this.absorb(packet);
      for (const waiter of [...this.waiters]) waiter(packet);
    }
  }
  private async send(name: MessageName, fields: Fields, force = false) {
    if (this.closedReason) throw new DeviceError('disconnected', 'The aircraft is not connected.');
    if (this.quiet && !force) throw new DeviceError('busy', 'The link is reserved for the ESCs right now.');
    await this.transport.write(encode(name, fields, this.seq++));
  }
  private waitFor<T>(match: (packet: Packet) => T | undefined, timeoutMs: number, onTimeout: string): Promise<T> {
    const d = deferred<T>(timeoutMs, onTimeout);
    const waiter = (packet: Packet) => { const hit = match(packet); if (hit !== undefined) d.resolve(hit); };
    this.waiters.add(waiter);
    const done = () => this.waiters.delete(waiter);
    d.promise.then(done, done);
    return d.promise;
  }
  private checkLink() {
    const ok = this.live.at > 0 && this.now() - this.live.at < 3500;
    if (ok !== this.live.linkOk) { this.live.linkOk = ok; this.emit({ type: 'state' }); }
    if (this.motorTestUntil && this.now() > this.motorTestUntil) this.motorTestUntil = 0;
  }
  private onClosed(reason: string) {
    if (this.closedReason) return;
    this.closedReason = reason;
    this.live.linkOk = false;
    clearInterval(this.tick);
    this.emit({ type: 'closed', reason });
  }
  async close() {
    for (const off of this.offs) off();
    clearInterval(this.tick);
    if (!this.closedReason) { this.closedReason = 'closed'; await this.transport.close().catch(() => {}); this.emit({ type: 'closed', reason: 'closed' }); }
  }
  private ready(requireDisarmed = true) {
    if (this.closedReason || !this.live.linkOk) throw new DeviceError('disconnected', 'The aircraft is not answering.', 'Check the cable, then reconnect.');
    if (requireDisarmed && this.live.armed) throw new DeviceError('blocked', 'The aircraft is armed. Disarm it first.');
  }
  private async requestStreams() {
    await this.send('COMMAND_LONG', this.cmd(512, [148]));
    for (const [id, hz] of STREAMS) await this.send('COMMAND_LONG', this.cmd(511, [id, 1e6 / hz]));
  }
  private cmd(command: number, p: number[] = []): Fields {
    return { target_system: this.target.sysid, target_component: this.target.compid, command, confirmation: 0,
      param1: p[0] ?? 0, param2: p[1] ?? 0, param3: p[2] ?? 0, param4: p[3] ?? 0, param5: p[4] ?? 0, param6: p[5] ?? 0, param7: p[6] ?? 0 };
  }
  /** Send a command and wait for its acknowledgement. "In progress" keeps waiting; anything but "accepted" is an error. */
  private async command(command: number, p: number[], what: string, timeoutMs = this.timing.ackMs): Promise<void> {
    const ack = this.waitFor(packet => {
      if (packet.name !== 'COMMAND_ACK' || Number(packet.fields.command) !== command) return undefined;
      const result = Number(packet.fields.result);
      return result === 5 ? undefined : result;
    }, timeoutMs, `${what}: the flight controller did not answer.`);
    await this.send('COMMAND_LONG', this.cmd(command, p));
    const result = await ack;
    if (result !== 0) throw new DeviceError(result === 3 ? 'unsupported' : 'rejected', `${what}: ${RESULT[result] ?? `result ${result}`}.`, this.live.armingBlocks[0]);
  }

  // ---- Telemetry ----------------------------------------------------------------------------------------------

  private absorb(p: Packet) {
    const f = p.fields, n = (key: string) => Number(f[key]);
    if (p.name === 'HEARTBEAT') {
      if (!this.isAutopilot(p)) return;
      this.target = { sysid: p.sysid, compid: p.compid };
      this.px4 = n('autopilot') === 12;
      const vehicle = VEHICLES[n('type')] ?? 'other';
      this.identity = { ...this.identity, stack: this.px4 ? 'px4' : 'ardupilot', vehicle, firmware: this.px4 ? 'PX4' : FIRMWARE[vehicle] ?? 'ArduCopter' };
      this.live.armed = (n('base_mode') & 0x80) !== 0;
      this.live.mode = modeName(this.px4, n('custom_mode'));
      this.live.at = this.now();
      this.live.linkOk = true;
    } else if (p.sysid !== this.target.sysid) return;
    else if (p.name === 'SYS_STATUS') {
      const present = n('onboard_control_sensors_present'), enabled = n('onboard_control_sensors_enabled'), health = n('onboard_control_sensors_health');
      for (const [bit, key] of SENSOR_BITS) {
        const state: Health = !(present & bit) ? 'absent' : !(enabled & bit) ? 'unknown' : health & bit ? 'ok' : 'bad';
        this.live.sensors[key] = state;
      }
      this.live.sensors.prearm = enabled & PREARM_BIT ? (health & PREARM_BIT ? 'ok' : 'bad') : 'unknown';
      if (this.live.sensors.prearm === 'ok') this.live.armingBlocks = [];
      const voltage = n('voltage_battery'), current = n('current_battery'), remaining = n('battery_remaining');
      if (voltage !== 65535) this.live.battery = { ...this.live.battery, voltage: voltage / 1000, current: current >= 0 ? current / 100 : undefined, remaining: remaining >= 0 ? remaining : undefined };
      this.live.cpuLoad = n('load') / 10;
    } else if (p.name === 'ATTITUDE') {
      const deg = (rad: number) => round((rad * 180) / Math.PI, 1);
      this.live.attitude = { roll: deg(n('roll')), pitch: deg(n('pitch')), yaw: (deg(n('yaw')) + 360) % 360 };
    } else if (p.name === 'GPS_RAW_INT') {
      const eph = n('eph');
      this.live.gps = { fix: n('fix_type'), sats: n('satellites_visible') === 255 ? 0 : n('satellites_visible'), hdop: eph === 65535 ? undefined : eph / 100,
        ...(n('fix_type') >= 2 ? { lat: n('lat') / 1e7, lon: n('lon') / 1e7, alt: n('alt') / 1000 } : {}) };
    } else if (p.name === 'RC_CHANNELS') {
      const count = Math.min(18, n('chancount'));
      const rssi = n('rssi');
      this.live.rc = { channels: Array.from({ length: count }, (_, i) => n(`chan${i + 1}_raw`)), rssi: rssi === 255 ? undefined : Math.round((rssi / 254) * 100) };
    } else if (p.name === 'SERVO_OUTPUT_RAW') {
      this.live.motors = { outputs: Array.from({ length: this.airframe().motors.length }, (_, i) => n(`servo${i + 1}_raw`)) };
    } else if (p.name === 'BATTERY_STATUS') {
      const cells = (f.voltages as number[]).filter(v => v !== 65535 && v > 0);
      if (cells.length > 1) this.live.battery = { voltage: round(cells.reduce((a, b) => a + b, 0) / 1000, 2), ...this.live.battery, cells: cells.length };
    } else if (p.name === 'VIBRATION') {
      this.live.vibration = { x: round(n('vibration_x'), 1), y: round(n('vibration_y'), 1), z: round(n('vibration_z'), 1), clipping: n('clipping_0') + n('clipping_1') + n('clipping_2') };
    } else if (p.name === 'VFR_HUD') this.live.altitude = round(n('alt'), 1);
    else if (p.name === 'ESC_TELEMETRY_1_TO_4') {
      const arr = (key: string) => f[key] as number[];
      this.live.esc = arr('rpm').map((rpm, i) => ({ rpm, temperature: arr('temperature')[i], voltage: arr('voltage')[i] / 100, current: arr('current')[i] / 100 }));
    } else if (p.name === 'STATUSTEXT') {
      const text = String(f.text).slice(0, 120);
      this.live.messages = [...this.live.messages.slice(-29), { at: this.now(), severity: n('severity'), text }];
      if (/^PreArm:/i.test(text)) { const reason = text.replace(/^PreArm:\s*/i, ''); if (!this.live.armingBlocks.includes(reason)) this.live.armingBlocks = [...this.live.armingBlocks.slice(-9), reason]; }
    } else if (p.name === 'AUTOPILOT_VERSION') {
      const v = n('flight_sw_version');
      const uid2 = f.uid2 as number[];
      this.identity = { ...this.identity, version: `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}`,
        uid: uid2.some(Boolean) ? uid2.map(b => b.toString(16).padStart(2, '0')).join('') : BigInt(f.uid as bigint).toString(16), board: `board ${n('board_version') >>> 16 || n('board_version')}` };
    } else if (p.name === 'PARAM_VALUE') this.absorbParam(f);
    else return;
    if (this.now() - this.lastEmit > 90 || p.name === 'HEARTBEAT' || p.name === 'STATUSTEXT') { this.lastEmit = this.now(); this.emit({ type: 'state' }); }
  }
  state() { return this.live; }
  airframe(): Airframe {
    if (this.px4) return px4Frame(name => this.params.get(name)?.value);
    return ardupilotFrame(this.params.get('FRAME_CLASS')?.value, this.params.get('FRAME_TYPE')?.value);
  }

  // ---- Parameters ---------------------------------------------------------------------------------------------

  private decodeValue(value: number, type: number) {
    if (!this.px4 || type === 9 || type === 10) return value;
    const dv = view(new Uint8Array(4)); dv.setFloat32(0, value, true);
    return type === 6 || type === 4 || type === 2 ? dv.getInt32(0, true) : dv.getUint32(0, true);
  }
  private encodeValue(value: number, type: number) {
    if (!this.px4 || type === 9 || type === 10) return value;
    const dv = view(new Uint8Array(4)); dv.setInt32(0, value, true);
    return dv.getFloat32(0, true);
  }
  private absorbParam(f: Fields) {
    const name = String(f.param_id), type = Number(f.param_type), index = Number(f.param_index);
    if (!/^[A-Z][A-Z0-9_]{0,15}$/.test(name)) return;
    const count = Number(f.param_count);
    if (count && count !== 65535) this.paramCount = count;
    const previous = this.params.get(name);
    this.params.set(name, { value: this.decodeValue(Number(f.param_value), type), type, index: index === 65535 ? previous?.index ?? -1 : index, at: this.now() });
  }
  settingsLoaded() { return this.loaded; }
  /** Apply fuller, version-matched descriptions, for example from the ArduPilot project's published metadata. */
  applyMetadata(meta: Record<string, Meta>) { this.meta = { ...ARDUPILOT_META, ...meta }; this.emit({ type: 'settings' }); }
  private toSetting(name: string, p: Param): Setting {
    const meta = this.meta[name], { part, group } = partOf(name);
    const integer = p.type !== 9 && p.type !== 10;
    const options = meta?.options ? Object.entries(meta.options).map(([value, label]) => ({ value: Number(value), label })) : undefined;
    return {
      id: `param.${name}`, name, part, group, value: integer ? p.value : round(p.value, 6), type: options ? 'enum' : 'number',
      options, min: meta?.min, max: meta?.max, step: meta?.step ?? (integer ? 1 : undefined), unit: meta?.unit, title: meta?.title,
      description: meta?.description, rebootRequired: meta?.rebootRequired, at: p.at,
    };
  }
  settings(): Setting[] {
    const out = [...this.params].sort((a, b) => a[0].localeCompare(b[0])).map(([name, p]) => this.toSetting(name, p));
    for (const read of this.escReads) if (read.block) out.push(...escSettings(read.info, read.block));
    return out;
  }
  async loadSettings(progress?: RunContext['progress']) {
    await this.exclusive('reading settings', async () => {
      this.ready(false);
      this.loaded = 'loading';
      const seen = new Set<number>();
      let last = this.now();
      const waiter = (p: Packet) => { if (p.name === 'PARAM_VALUE' && Number(p.fields.param_index) !== 65535) { seen.add(Number(p.fields.param_index)); last = this.now(); } };
      this.waiters.add(waiter);
      try {
        await this.send('PARAM_REQUEST_LIST', { target_system: this.target.sysid, target_component: this.target.compid });
        for (let round = 0; round < 5; round++) {
          for (;;) {
            await sleep(Math.min(100, this.timing.paramIdleMs / 4));
            progress?.('Reading settings', seen.size, this.paramCount);
            if (this.paramCount && seen.size >= this.paramCount) break;
            if (this.now() - last > this.timing.paramIdleMs) break;
            if (this.closedReason) throw new DeviceError('disconnected', 'The aircraft disconnected while settings were being read.');
          }
          if (!this.paramCount) throw new DeviceError('timeout', 'The flight controller did not send its settings.');
          if (seen.size >= this.paramCount) break;
          // Ask again only for the entries that never arrived.
          const missing = Array.from({ length: this.paramCount }, (_, i) => i).filter(i => !seen.has(i)).slice(0, 200);
          for (const index of missing) await this.send('PARAM_REQUEST_READ', { target_system: this.target.sysid, target_component: this.target.compid, param_id: '', param_index: index });
          last = this.now();
        }
        this.loaded = this.paramCount !== undefined && seen.size >= this.paramCount ? 'complete' : 'partial';
      } catch (error) { this.loaded = this.params.size ? 'partial' : 'none'; throw error; }
      finally { this.waiters.delete(waiter); this.emit({ type: 'settings' }); }
    });
  }
  private async readParam(name: string): Promise<Param> {
    const sent = this.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = this.waitFor(p => p.name === 'PARAM_VALUE' && p.fields.param_id === name ? true : undefined, this.timing.echoMs, `No answer for ${name}.`).catch(() => false);
      await this.send('PARAM_REQUEST_READ', { target_system: this.target.sysid, target_component: this.target.compid, param_id: name, param_index: -1 });
      if (await answer) { const p = this.params.get(name)!; if (p.at >= sent) return p; }
    }
    throw new DeviceError('timeout', `The flight controller did not report ${name}.`, 'It may not exist on this firmware.');
  }
  async refresh(ids: string[]): Promise<Setting[]> {
    return this.exclusive('reading settings', async () => {
      this.ready(false);
      const out: Setting[] = [];
      for (const id of ids) {
        if (id.startsWith('param.')) { const name = id.slice(6); out.push(this.toSetting(name, await this.readParam(name))); }
        else { const cached = this.settings().find(s => s.id === id); if (cached) out.push(cached); }
      }
      this.emit({ type: 'settings', ids });
      return out;
    });
  }
  private same(a: number, b: number) { return f32(a) === f32(b) || Math.abs(a - b) <= Math.abs(b) * 1e-6; }
  private toNumber(setting: Setting, value: SettingValue): number {
    if (typeof value === 'string') {
      const option = setting.options?.find(o => o.label.toLowerCase() === value.toLowerCase());
      if (option) return Number(option.value);
      if (value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      throw new DeviceError('invalid', `"${value}" is not a valid value for ${setting.name}.`, setting.options ? `Use one of: ${setting.options.map(o => o.label).join(', ')}.` : 'Use a number.');
    }
    return value;
  }
  async write(changes: Change[], ctx: RunContext): Promise<ChangeResult[]> {
    requireGrant(ctx, 'write', changes.some(c => c.id.startsWith('esc.')) ? ['propsRemoved', 'directUsb'] : []);
    return this.exclusive('writing settings', async () => {
      this.ready();
      const results: ChangeResult[] = [];
      const escChanges = changes.filter(c => c.id.startsWith('esc.'));
      for (const change of changes.filter(c => c.id.startsWith('param.'))) {
        const name = change.id.slice(6);
        try {
          const before = await this.readParam(name);
          const setting = this.toSetting(name, before);
          const value = this.toNumber(setting, change.value);
          if (!Number.isFinite(value)) throw new DeviceError('invalid', `${name} needs a number.`);
          if (before.type !== 9 && before.type !== 10 && !Number.isInteger(value)) throw new DeviceError('invalid', `${name} takes whole numbers.`);
          if (setting.min !== undefined && setting.max !== undefined && (value < setting.min || value > setting.max))
            throw new DeviceError('invalid', `${name} must be between ${setting.min} and ${setting.max}.`);
          if (change.expected !== undefined && !this.same(before.value, this.toNumber(setting, change.expected)))
            throw new DeviceError('stale', `${name} is now ${before.value}, not ${change.expected}. Nothing was written.`, 'Read it again and propose a new change.');
          ctx.progress?.(`Writing ${name}`);
          const echo = this.waitFor(p => p.name === 'PARAM_VALUE' && p.fields.param_id === name ? true : undefined, this.timing.echoMs, '').catch(() => false);
          await this.send('PARAM_SET', { target_system: this.target.sysid, target_component: this.target.compid, param_id: name, param_value: this.encodeValue(value, before.type), param_type: before.type });
          await echo;
          const after = await this.readParam(name);
          const ok = this.same(after.value, value);
          results.push({ id: change.id, before: before.value, requested: value, after: after.value, ok, note: ok ? (setting.rebootRequired ? 'Restart the flight controller for this to take effect.' : undefined) : 'The flight controller kept a different value.' });
        } catch (error) {
          results.push({ id: change.id, before: this.params.get(name)?.value ?? null, requested: change.value, after: this.params.get(name)?.value ?? null, ok: false, note: error instanceof Error ? error.message : 'Write failed.' });
        }
      }
      for (const change of changes.filter(c => !c.id.startsWith('param.') && !c.id.startsWith('esc.')))
        results.push({ id: change.id, before: null, requested: change.value, after: null, ok: false, note: 'Unknown setting.' });
      if (escChanges.length) results.push(...await this.writeEscs(escChanges, ctx));
      this.emit({ type: 'settings', ids: changes.map(c => c.id) });
      return results;
    });
  }

  // ---- ESCs ---------------------------------------------------------------------------------------------------

  escs(): EscInfo[] { return this.escReads.map(r => r.info); }
  private async escSession<T>(write: boolean, ctx: RunContext, fn: (link: FourWay, count: number) => Promise<T>): Promise<T> {
    if (this.px4) throw new DeviceError('unsupported', 'ESC passthrough is not available on PX4.');
    const auto = this.params.get('SERVO_BLH_AUTO'), port = this.params.get('SERVO_BLH_PORT');
    if (auto?.value !== 1 || port?.value !== 0)
      throw new DeviceError('blocked', 'ESC passthrough is switched off on this flight controller.', 'Set param.SERVO_BLH_AUTO to 1 and param.SERVO_BLH_PORT to 0, restart the flight controller, then try again.');
    if (!this.live.battery || this.live.battery.voltage < 2)
      throw new DeviceError('blocked', 'The ESCs have no power.', 'Connect the flight battery with the props removed.');
    this.quiet = true;
    const link = new FourWay({ write: bytes => this.transport.write(bytes), onData: listener => { this.raw.add(listener); return () => this.raw.delete(listener); } }, this.timing.esc);
    let entered = false;
    try {
      // ArduPilot only recognises its alternate protocol after four seconds without inbound MAVLink.
      ctx.progress?.('Quieting the link');
      await sleep(this.timing.quietMs);
      this.ready();
      const api = await link.msp(1);
      if (api.length !== 3 || api[1] !== 1) throw new DeviceError('unsupported', 'Unexpected passthrough interface version.');
      if (ascii(await link.msp(2)) !== 'ARDU') throw new DeviceError('mismatch', 'Expected ArduPilot ESC passthrough.');
      entered = true;
      const count = (await link.msp(245))[0];
      if (!(count >= 1 && count <= 8)) throw new DeviceError('mismatch', 'The flight controller did not report a valid ESC count.');
      await sleep(this.timing.esc.settleMs);
      link.allowWrites = write;
      return await fn(link, count);
    } finally {
      link.allowWrites = false;
      if (entered) await link.exit().catch(() => {});
      link.dispose();
      this.quiet = false;
      // Telemetry resumes on its own once the passthrough ends.
      await this.waitFor(p => p.name === 'HEARTBEAT' && this.isAutopilot(p) ? true : undefined, this.timing.restoreMs, '').catch(() => {});
      await this.requestStreams().catch(() => {});
    }
  }
  private session: EscSession = (write, ctx, fn) => this.escSession(write, ctx, fn);
  private async readEscs(ctx: RunContext): Promise<TestResult> {
    const { reads, result } = await readAllEscs(this.session, ctx, this.now);
    this.escReads = reads;
    this.emit({ type: 'settings' });
    return result;
  }
  private async writeEscs(changes: Change[], ctx: RunContext): Promise<ChangeResult[]> {
    const { reads, results } = await writeEscChanges(this.session, ctx, this.now, changes, this.escReads);
    this.escReads = reads;
    return results;
  }

  // ---- Tests and procedures -----------------------------------------------------------------------------------

  tests(): TestSpec[] {
    const motors = this.airframe().motors.length;
    const all: TestSpec[] = [
      { id: 'link.check', name: 'Link check', part: 'link', level: 0, seconds: 2, needs: [], proves: 'The flight controller is answering steadily over this connection.' },
      { id: 'sensors.check', name: 'Sensor health', part: 'fc', level: 0, seconds: 1, needs: [], proves: 'Each sensor the flight controller uses reports healthy.' },
      { id: 'prearm.check', name: 'Arming checks', part: 'safety', level: 0, seconds: 4, needs: [], proves: 'The flight controller would allow arming, or lists exactly why not.' },
      { id: 'radio.check', name: 'Radio check', part: 'receiver', level: 0, seconds: 2, needs: [], proves: 'The receiver is delivering stick and switch positions.' },
      { id: 'battery.check', name: 'Battery check', part: 'battery', level: 0, seconds: 1, needs: [], proves: 'Battery voltage is being measured and is in a believable range.' },
      { id: 'diagnostics.full', name: 'Full check', part: 'fc', level: 0, seconds: 8, needs: [], proves: 'Link, sensors, arming checks, radio and battery, in one pass.' },
      { id: 'settings.snapshot', name: 'Settings snapshot', part: 'fc', level: 0, seconds: 10, needs: [], proves: 'A complete copy of every setting, for backup or comparison.' },
      { id: 'logs.list', name: 'List flight logs', part: 'logging', level: 0, seconds: 3, needs: [], proves: 'Which flight recordings are stored on the aircraft.' },
      { id: 'logs.analyze', name: 'Analyse a flight log', part: 'logging', level: 0, seconds: 60, needs: [], proves: 'Vibration, control tracking, throttle and battery behaviour during a recorded flight.',
        args: [{ name: 'log', type: 'number', min: 1 }] },
      { id: 'esc.read', name: 'Read ESCs', part: 'motors', level: 2, seconds: 12, needs: ['propsRemoved', 'directUsb', 'batteryConnected'], proves: 'Firmware and settings of each ESC, including spin direction.' },
      { id: 'cal.level', name: 'Level calibration', part: 'fc', level: 2, seconds: 5, needs: ['level', 'still'], proves: 'The flight controller knows which way is level.' },
      { id: 'cal.gyro', name: 'Gyro calibration', part: 'fc', level: 2, seconds: 5, needs: ['still'], proves: 'Gyro offsets are measured at rest.' },
      { id: 'cal.baro', name: 'Barometer calibration', part: 'fc', level: 2, seconds: 5, needs: ['still'], proves: 'Ground pressure is recorded as zero altitude.' },
      { id: 'cal.accel.simple', name: 'Simple accelerometer calibration', part: 'fc', level: 2, seconds: 6, needs: ['level', 'still'], proves: 'Accelerometer offsets are measured with the aircraft level.' },
      { id: 'cal.compass', name: 'Compass calibration', part: 'compass', level: 2, seconds: 60, needs: ['batteryConnected'], interactive: true, proves: 'Compass offsets are measured while you turn the aircraft through every direction.' },
      { id: 'fc.restart', name: 'Restart flight controller', part: 'fc', level: 2, seconds: 8, needs: [], proves: 'Settings that need a restart are now in effect.' },
      { id: 'motor.spin', name: 'Motor spin', part: 'motors', level: 3, seconds: 2, needs: ['propsRemoved', 'areaClear'], proves: 'Which physical motor a number refers to, and which way it turns.',
        args: [{ name: 'motor', type: 'number', min: 1, max: motors, required: true }, { name: 'throttle', type: 'number', min: 3, max: 15, default: 5, unit: '%' }, { name: 'seconds', type: 'number', min: 0.5, max: 3, default: 1, unit: 's' }] },
      { id: 'esc.flash', name: 'Flash ESC firmware', part: 'motors', level: 3, seconds: 90, needs: ['propsRemoved', 'directUsb', 'batteryConnected', 'firmwareMatchesBoard'], interactive: true, proves: 'Each ESC runs the chosen firmware, verified by reading it back.',
        args: [{ name: 'esc', type: 'number', min: 1, max: 8 }, { name: 'file', type: 'file', required: true }] },
    ];
    return this.px4 ? all.filter(t => !t.id.startsWith('esc.') && t.id !== 'cal.accel.simple') : all;
  }
  async stop() {
    if (this.closedReason) return;
    for (let motor = 1; motor <= this.airframe().motors.length; motor++) await this.send('COMMAND_LONG', this.cmd(209, [motor, 0, 0, 0, 1]), true).catch(() => {});
    this.motorTestUntil = 0;
  }
  private result(id: string, ok: boolean | null, summary: string, data?: unknown): TestResult { return { id, ok, summary, data, at: this.now() }; }

  async run(id: string, ctx: RunContext = {}): Promise<TestResult> {
    const spec = this.tests().find(t => t.id === id);
    if (!spec) throw new DeviceError('unsupported', `There is no test "${id}" on this aircraft.`);
    if (spec.level > 0) requireGrant(ctx, id, spec.needs);
    const args = ctx.args ?? {};
    const num = (name: string) => { const a = spec.args!.find(x => x.name === name)!; const v = args[name] === undefined ? a.default : Number(args[name]); if (v === undefined || !Number.isFinite(Number(v)) || Number(v) < a.min! || Number(v) > a.max!) throw new DeviceError('invalid', `${name} must be from ${a.min} to ${a.max}.`); return Number(v); };
    switch (id) {
      case 'link.check': return this.linkCheck();
      case 'sensors.check': return this.sensorCheck();
      case 'battery.check': return this.batteryCheck();
      case 'radio.check': return this.radioCheck();
      case 'prearm.check': return this.exclusive('arming checks', () => this.prearmCheck());
      case 'diagnostics.full': return this.exclusive('full check', async () => {
        const parts = [await this.linkCheck(), this.sensorCheck(), this.batteryCheck(), this.radioCheck(), await this.prearmCheck()];
        const failed = parts.filter(p => p.ok === false), unknown = parts.filter(p => p.ok === null);
        return this.result(id, failed.length ? false : unknown.length ? null : true,
          failed.length ? `${failed.length} problem${failed.length > 1 ? 's' : ''}: ${failed.map(p => p.summary).join(' ')}` : unknown.length ? `No problems found. ${unknown.length} check${unknown.length > 1 ? 's' : ''} could not be completed.` : 'Everything checked is healthy.',
          parts.map(({ id: check, ok, summary }) => ({ check, ok, summary })));
      });
      case 'settings.snapshot': {
        if (this.loaded !== 'complete') await this.loadSettings(ctx.progress);
        const values = Object.fromEntries([...this.params].map(([name, p]) => [name, p.value]));
        return this.result(id, this.loaded === 'complete', `${this.params.size} settings captured${this.loaded === 'complete' ? '' : ' (incomplete)'}.`, { stack: this.identity.stack, version: this.identity.version, values });
      }
      case 'logs.list': return this.exclusive('listing logs', () => this.listLogs());
      case 'logs.analyze': return this.exclusive('downloading a log', () => this.analyzeLog(args.log === undefined ? undefined : Number(args.log), ctx));
      case 'esc.read': return this.exclusive('reading ESCs', async () => { this.ready(); return this.readEscs(ctx); });
      case 'esc.flash': return this.exclusive('flashing ESCs', async () => { this.ready(); return this.flashEscs(args.esc === undefined ? undefined : Number(args.esc), ctx); });
      case 'cal.level': return this.calibrate(id, [0, 0, 0, 0, 2], 'Level calibration', ['AHRS_TRIM_X', 'AHRS_TRIM_Y']);
      case 'cal.gyro': return this.calibrate(id, [1], 'Gyro calibration', []);
      case 'cal.baro': return this.calibrate(id, [0, 0, 1], 'Barometer calibration', []);
      case 'cal.accel.simple': return this.calibrate(id, [0, 0, 0, 0, 4], 'Accelerometer calibration', ['INS_ACCOFFS_X', 'INS_ACCOFFS_Y', 'INS_ACCOFFS_Z']);
      case 'cal.compass': return this.exclusive('compass calibration', () => this.compassCal(ctx));
      case 'fc.restart': return this.exclusive('restarting', async () => {
        this.ready();
        await this.command(246, [1], 'Restart');
        this.emit({ type: 'reconnect-needed', reason: 'The flight controller is restarting.' });
        return this.result(id, true, 'Restart accepted. Reconnect in a few seconds.');
      });
      case 'motor.spin': return this.exclusive('motor test', async () => {
        this.ready();
        const motor = num('motor'), throttle = num('throttle'), seconds = num('seconds');
        await this.command(209, [motor, 0, throttle, seconds, 1], `Motor ${motor} test`);
        this.motorTestUntil = this.now() + seconds * 1000;
        await sleep(seconds * 1000);
        return this.result(id, null, `Motor ${motor} was commanded to ${throttle}% for ${seconds} s. Confirm by eye which motor turned and which way.`, { motor, throttle, seconds });
      });
      default: throw new DeviceError('unsupported', `"${id}" is not implemented.`);
    }
  }
  private async linkCheck(): Promise<TestResult> {
    let beats = 0;
    const waiter = (p: Packet) => { if (p.name === 'HEARTBEAT' && this.isAutopilot(p)) beats++; };
    this.waiters.add(waiter);
    const junk = this.parser.junk;
    await sleep(Math.min(2200, this.timing.heartbeatMs / 2.5));
    this.waiters.delete(waiter);
    const noise = this.parser.junk - junk;
    return this.result('link.check', beats >= 1 && noise < 200, beats ? `Link is steady${noise ? `, with ${noise} unreadable bytes` : ''}.` : 'No heartbeat in the last two seconds.', { heartbeats: beats, unreadableBytes: noise });
  }
  private sensorCheck(): TestResult {
    const entries = Object.entries(this.live.sensors).filter(([key]) => key !== 'prearm');
    if (!entries.length) return this.result('sensors.check', null, 'No sensor report has arrived yet.');
    const bad = entries.filter(([, v]) => v === 'bad').map(([k]) => k);
    return this.result('sensors.check', bad.length === 0, bad.length ? `Unhealthy: ${bad.join(', ')}.` : 'All reported sensors are healthy.', Object.fromEntries(entries));
  }
  private batteryCheck(): TestResult {
    const b = this.live.battery;
    if (!b) return this.result('battery.check', null, 'No battery reading. The monitor may be off, or the battery is not connected.');
    const cells = b.cells ?? Math.max(1, Math.round(b.voltage / 3.9));
    const perCell = b.voltage / cells;
    const ok = b.voltage < 2 ? null : perCell >= 3.3 && perCell <= 4.4;
    return this.result('battery.check', ok, b.voltage < 2 ? 'USB power only; the flight battery is not connected.' : `${round(b.voltage, 2)} V, about ${round(perCell, 2)} V per cell across ${cells} cells.`, { ...b, estimatedCells: cells });
  }
  private radioCheck(): TestResult {
    const rc = this.live.rc;
    if (!rc || !rc.channels.length) return this.result('radio.check', this.live.sensors.receiver === 'bad' ? false : null, 'No receiver data. Switch the transmitter on and check the receiver wiring and protocol.');
    const live = rc.channels.slice(0, 4).every(v => v >= 800 && v <= 2200);
    return this.result('radio.check', live, live ? `${rc.channels.length} channels arriving${rc.rssi !== undefined ? `, signal ${rc.rssi}%` : ''}.` : 'Channel values are out of range.', rc);
  }
  private async prearmCheck(): Promise<TestResult> {
    this.ready(false);
    if (this.px4) return this.result('prearm.check', this.live.sensors.prearm === 'ok' ? true : this.live.sensors.prearm === 'bad' ? false : null, this.live.sensors.prearm === 'ok' ? 'Ready to arm.' : 'PX4 reports it is not ready to arm.', { messages: this.live.messages.slice(-5).map(m => m.text) });
    this.live.armingBlocks = [];
    await this.command(401, [], 'Arming checks').catch(error => { if (!(error instanceof DeviceError) || error.code !== 'unsupported') throw error; });
    await sleep(Math.min(3000, this.timing.ackMs));
    const blocks = this.live.armingBlocks;
    const state = this.live.sensors.prearm;
    return this.result('prearm.check', blocks.length ? false : state === 'ok' ? true : null, blocks.length ? `Will not arm: ${blocks.join('; ')}.` : state === 'ok' ? 'Arming checks pass.' : 'No failures reported, but the flight controller has not confirmed a pass.', { blocks });
  }
  private calibrate(id: string, params: number[], label: string, changed: string[]) {
    return this.exclusive(label.toLowerCase(), async () => {
      this.ready();
      const before = Object.fromEntries(await Promise.all(changed.map(async name => [name, (await this.readParam(name).catch(() => undefined))?.value])));
      const mark = this.live.messages.length;
      await this.command(241, params, label, 30000);
      await sleep(Math.min(500, this.timing.echoMs));
      const after = Object.fromEntries(await Promise.all(changed.map(async name => [name, (await this.readParam(name).catch(() => undefined))?.value])));
      this.emit({ type: 'settings', ids: changed.map(n => `param.${n}`) });
      return this.result(id, true, `${label} accepted.`, { before, after, messages: this.live.messages.slice(mark).map(m => m.text) });
    });
  }
  private async compassCal(ctx: RunContext): Promise<TestResult> {
    this.ready();
    await this.command(42424, [0, 0, 1, 0, 0], 'Compass calibration');
    const report = await this.waitFor(p => {
      if (p.name === 'MAG_CAL_PROGRESS') { ctx.progress?.('Turn the aircraft through every direction', Number(p.fields.completion_pct), 100); return undefined; }
      if (p.name === 'MAG_CAL_REPORT') return p.fields;
      return undefined;
    }, 120000, 'Compass calibration did not finish. Keep turning the aircraft, away from metal.').catch(async error => { await this.command(42426, [], 'Cancel').catch(() => {}); throw error; });
    const status = Number(report.cal_status), fitness = round(Number(report.fitness), 1);
    return this.result('cal.compass', status === 4, status === 4 ? `Compass calibrated, fitness ${fitness}. Restart the flight controller.` : `Compass calibration failed (status ${status}). Try again outdoors, away from metal.`, { fitness, offsets: [report.ofs_x, report.ofs_y, report.ofs_z].map(v => round(Number(v), 1)) });
  }
  private async flashEscs(only: number | undefined, ctx: RunContext): Promise<TestResult> {
    const { reads, result } = await flashEscs(this.session, ctx, this.now, only, this.escReads);
    this.escReads = reads;
    this.emit({ type: 'settings' });
    return result;
  }

  // ---- Flight logs --------------------------------------------------------------------------------------------

  logs() { return this.logList; }
  lastLogAnalysis() { return this.lastLog; }
  private async listLogs(): Promise<TestResult> {
    this.ready();
    const entries = new Map<number, LogEntry>();
    let total = -1, last = this.now();
    const waiter = (p: Packet) => {
      if (p.name !== 'LOG_ENTRY') return;
      total = Number(p.fields.num_logs); last = this.now();
      if (total > 0) entries.set(Number(p.fields.id), { id: Number(p.fields.id), size: Number(p.fields.size), time: Number(p.fields.time_utc) || undefined });
    };
    this.waiters.add(waiter);
    try {
      await this.send('LOG_REQUEST_LIST', { target_system: this.target.sysid, target_component: this.target.compid, start: 0, end: 0xffff });
      while (total < 0 ? this.now() - last < this.timing.ackMs : entries.size < total && this.now() - last < this.timing.logIdleMs * 2) await sleep(40);
    } finally { this.waiters.delete(waiter); }
    if (total < 0) throw new DeviceError('timeout', 'The flight controller did not list its logs.');
    this.logList = [...entries.values()].sort((a, b) => a.id - b.id);
    return this.result('logs.list', true, this.logList.length ? `${this.logList.length} flight log${this.logList.length > 1 ? 's' : ''} on the aircraft.` : 'No flight logs are stored.', this.logList);
  }
  private async analyzeLog(wanted: number | undefined, ctx: RunContext): Promise<TestResult> {
    if (!this.logList.length || (wanted !== undefined && !this.logList.some(l => l.id === wanted))) await this.listLogs();
    const entry = wanted === undefined ? this.logList.at(-1) : this.logList.find(l => l.id === wanted);
    if (!entry) throw new DeviceError('invalid', wanted === undefined ? 'There are no flight logs to analyse.' : `There is no log ${wanted}.`, `Available: ${this.logList.map(l => l.id).join(', ') || 'none'}.`);
    if (entry.size <= 0 || entry.size > LOG_MAX) throw new DeviceError('unsupported', 'That log is empty or too large to download here.');
    const data = new Uint8Array(entry.size), have = new Uint8Array(Math.ceil(entry.size / 90));
    let received = 0, last = this.now();
    const waiter = (p: Packet) => {
      if (p.name !== 'LOG_DATA' || Number(p.fields.id) !== entry.id) return;
      const ofs = Number(p.fields.ofs), count = Number(p.fields.count);
      if (count < 1 || count > 90 || ofs % 90 || ofs + count > entry.size || have[ofs / 90]) return;
      data.set((p.fields.data as number[]).slice(0, count), ofs); have[ofs / 90] = 1; received += count; last = this.now();
    };
    this.waiters.add(waiter);
    // The flight controller only keeps streaming a log to a ground station it can hear.
    const beat = setInterval(() => void this.send('HEARTBEAT', { type: 6, autopilot: 8, base_mode: 0, custom_mode: 0, system_status: 4, mavlink_version: 3 }).catch(() => {}), 1000);
    try {
      for (let stalls = 0; received < entry.size;) {
        if (ctx.signal?.aborted) throw new DeviceError('rejected', 'Log download was cancelled.');
        const gap = have.indexOf(0) * 90;
        const before = received;
        await this.send('LOG_REQUEST_DATA', { target_system: this.target.sysid, target_component: this.target.compid, id: entry.id, ofs: gap, count: Math.min(LOG_WINDOW, entry.size - gap) });
        last = this.now();
        while (this.now() - last < this.timing.logIdleMs && received < entry.size && have.indexOf(0) * 90 < gap + LOG_WINDOW) await sleep(15);
        ctx.progress?.('Downloading flight log', received, entry.size);
        stalls = received === before ? stalls + 1 : 0;
        if (stalls >= 4) throw new DeviceError('timeout', 'The log download stalled.', 'Keep the cable connected and try again.');
      }
    } finally {
      clearInterval(beat); this.waiters.delete(waiter);
      await this.send('LOG_REQUEST_END', { target_system: this.target.sysid, target_component: this.target.compid }).catch(() => {});
    }
    const analysis = analyzeDataFlash(data);
    this.lastLog = { id: entry.id, analysis };
    return this.result('logs.analyze', true, `Log ${entry.id} downloaded and analysed (${Math.round(entry.size / 1024)} KB).`, { log: entry.id, analysis });
  }
}
