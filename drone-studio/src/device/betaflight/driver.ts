import { betaflightFrame } from '../airframe';
import { ascii, deferred, DeviceError, latin1, Reader, round, sleep, Writer } from '../bytes';
import { escSettings, ESC_TIMING, FourWay, type EscRead, type EscTiming } from '../esc/fourway';
import { flashEscs, readAllEscs, writeEscChanges, type EscSession } from '../esc/session';
import { requireGrant } from '../mavlink/driver';
import { encodeMsp, encodeMspV2, MSP, MspParser, type MspFrame } from '../msp/codec';
import { analyzeBlackbox } from '../blackbox/analyze';
import { decodeAll, type BlackboxLog } from '../blackbox/decode';
import type { FlightLogAnalysis } from '../../aircraft/dataflash-analysis';
import type { ByteTransport } from '../transport';
import {
  DriverBase, type Airframe, type Change, type ChangeResult, type Driver, type EscInfo, type Health, type Identity, type LiveState,
  type LogEntry, type RunContext, type Setting, type TestResult, type TestSpec,
} from '../types';
import { decodeOsd, OSD_NAMES, parseOsdValue } from './osd';
import { checkEspImage, elrsCommand, EspLoader, SYNC_FRAME } from '../flash/esp';
import { frequency, parseVtxTable, presetName, validateVtxTable, vtxTableCommands, VTX_PRESETS, type VtxTable } from './vtx';
import { ARMING_EXPECTED, ARMING_FLAGS, ARMING_WORDS, parseDump, parseGet, restoreLines, safeName, safeValue, toSetting, type GetInfo } from './cli';

/**
 * Betaflight and INAV. MSP carries identity and live readings; the text console carries every setting.
 * Saving restarts the flight controller, exactly as it does in Betaflight's own app, so a write ends with
 * "reconnect needed" and the runtime verifies the saved values after it reconnects.
 *
 * This driver has been exercised against the simulator in src/device/sim/betaflight.ts only.
 */
export interface BfTiming { mspMs: number; cliMs: number; cliIdleMs: number; pollMs: number; rebootMs: number; esc: EscTiming }
export const BF_TIMING: BfTiming = { mspMs: 800, cliMs: 8000, cliIdleMs: 150, pollMs: 100, rebootMs: 1500, esc: ESC_TIMING };
const SENSORS: [number, string][] = [[1, 'accel'], [2, 'baro'], [4, 'compass'], [8, 'gps'], [32, 'gyro']];
const FEATURE_3D = 1 << 12, FEATURE_GPS = 1 << 7;

export class BetaflightDriver extends DriverBase implements Driver {
  identity: Identity = { stack: 'betaflight', firmware: 'Betaflight', version: 'unknown', vehicle: 'quad' };
  readonly transportLabel: string;
  private msp = new MspParser();
  private mspQueue: { command: number; resolve: (payload: Uint8Array) => void; reject: (error: Error) => void }[] = [];
  private raw = new Set<(bytes: Uint8Array) => void>();
  private mode: 'msp' | 'cli' | 'esc' | 'passthrough' = 'msp';
  private cliText = '';
  private cliWaiter?: () => void;
  private live: LiveState = { at: 0, linkOk: false, armed: false, mode: 'Unknown', sensors: {}, armingBlocks: [], messages: [] };
  private mixer?: number;
  private yawReversed = false;
  private motorCount = 4;
  private features = 0;
  private values = new Map<string, { value: string; scope?: string; at: number }>();
  private info = new Map<string, GetInfo>();
  private lines = new Map<string, { value: string; at: number }>();
  private loaded: 'none' | 'loading' | 'partial' | 'complete' = 'none';
  private backup = '';
  private escReads: EscRead[] = [];
  private flash?: { bytes: Uint8Array; logs: BlackboxLog[] };
  private vtx?: { table?: VtxTable; at: number };
  private analysed?: { id: number; analysis: FlightLogAnalysis };
  private offs: (() => void)[] = [];
  private poll?: ReturnType<typeof setInterval>;
  private pollBusy = false;
  private tickCount = 0;
  private closedReason?: string;
  private expectingReboot = false;
  private lastEmit = 0;

  private constructor(private transport: ByteTransport, private timing: BfTiming, private now: () => number) {
    super();
    this.transportLabel = transport.label;
    this.offs.push(transport.onData(chunk => this.receive(chunk)), transport.onClose(reason => this.onClosed(reason)));
  }
  static async connect(transport: ByteTransport, options: { timing?: Partial<BfTiming>; now?: () => number } = {}): Promise<BetaflightDriver> {
    const driver = new BetaflightDriver(transport, { ...BF_TIMING, ...options.timing, esc: { ...ESC_TIMING, ...options.timing?.esc } }, options.now ?? Date.now);
    try { await driver.identify(); driver.startPolling(); return driver; }
    catch (error) { await driver.close(); throw error; }
  }

  // ---- Link ---------------------------------------------------------------------------------------------------

  private receive(chunk: Uint8Array) {
    for (const listener of [...this.raw]) listener(chunk);
    if (this.mode === 'passthrough') return;
    if (this.mode === 'cli') { this.cliText += latin1(chunk); this.cliWaiter?.(); return; }
    if (this.mode !== 'msp') return;
    for (const frame of this.msp.push(chunk)) this.onFrame(frame);
  }
  private onFrame(frame: MspFrame) {
    if (frame.direction === '<') return;
    const next = this.mspQueue[0];
    if (!next || next.command !== frame.command) return;
    this.mspQueue.shift();
    this.live.at = this.now();
    this.live.linkOk = true;
    if (frame.direction === '!') next.reject(new DeviceError('unsupported', `The flight controller does not support request ${frame.command}.`));
    else next.resolve(frame.payload);
  }
  private request(command: number, payload?: Uint8Array, timeoutMs = this.timing.mspMs, v2 = false): Promise<Uint8Array> {
    if (this.closedReason) return Promise.reject(new DeviceError('disconnected', 'The aircraft is not connected.'));
    if (this.mode !== 'msp') return Promise.reject(new DeviceError('busy', 'The link is busy with another task.'));
    const d = deferred<Uint8Array>(timeoutMs, 'The flight controller did not answer.');
    const entry = { command, resolve: d.resolve, reject: d.reject };
    this.mspQueue.push(entry);
    d.promise.catch(() => { const at = this.mspQueue.indexOf(entry); if (at >= 0) this.mspQueue.splice(at, 1); });
    this.transport.write(v2 ? encodeMspV2(command, payload) : encodeMsp(command, payload)).catch(error => d.reject(error instanceof Error ? error : new DeviceError('disconnected', 'Write failed.')));
    return d.promise;
  }
  private onClosed(reason: string) {
    if (this.closedReason) return;
    this.closedReason = reason;
    this.live.linkOk = false;
    clearInterval(this.poll);
    for (const q of this.mspQueue.splice(0)) q.reject(new DeviceError('disconnected', 'The aircraft disconnected.'));
    this.cliWaiter?.();
    if (this.expectingReboot) this.emit({ type: 'reconnect-needed', reason: 'The flight controller is restarting.' });
    this.emit({ type: 'closed', reason });
  }
  async close() {
    for (const off of this.offs) off();
    clearInterval(this.poll);
    if (!this.closedReason) { this.closedReason = 'closed'; await this.transport.close().catch(() => {}); this.emit({ type: 'closed', reason: 'closed' }); }
  }
  private ready(requireDisarmed = true) {
    if (this.closedReason) throw new DeviceError('disconnected', 'The aircraft is not connected.', 'Reconnect it.');
    if (requireDisarmed && this.live.armed) throw new DeviceError('blocked', 'The aircraft is armed. Disarm it first.');
  }

  private async identify() {
    const api = await this.request(MSP.API_VERSION, undefined, 2500).catch(() => { throw new DeviceError('timeout', 'No flight controller answered. Check the cable and that this port is the flight controller.'); });
    const variant = ascii(await this.request(MSP.FC_VARIANT));
    const version = await this.request(MSP.FC_VERSION);
    if (variant !== 'BTFL' && variant !== 'INAV') throw new DeviceError('unsupported', `Unsupported firmware "${variant}".`, 'Lucidity supports Betaflight, INAV, ArduPilot and PX4.');
    this.identity = { stack: variant === 'INAV' ? 'inav' : 'betaflight', firmware: variant === 'INAV' ? 'INAV' : 'Betaflight', vehicle: 'quad',
      version: `${version[0]}.${version[1]}.${version[2]}`, apiVersion: `${api[1]}.${api[2]}` };
    const board = await this.request(MSP.BOARD_INFO).catch(() => undefined);
    if (board && board.length >= 4) {
      const r = new Reader(board);
      let name = ascii(r.bytesOf(4));
      try { r.skip(4); const targetLength = r.u8(); r.skip(targetLength); const boardLength = r.u8(); const boardName = ascii(r.bytesOf(boardLength)); if (boardName) name = boardName; } catch { /* older layout */ }
      this.identity.board = name;
    }
    const craft = await this.request(MSP.NAME).catch(() => undefined);
    if (craft?.length) this.identity.craftName = ascii(craft);
    const uid = await this.request(MSP.UID).catch(() => undefined);
    if (uid?.length === 12) this.identity.uid = Array.from(uid, b => b.toString(16).padStart(2, '0')).join('');
    const mixer = await this.request(MSP.MIXER_CONFIG).catch(() => undefined);
    if (mixer?.length) { this.mixer = mixer[0]; this.yawReversed = mixer[1] === 1; }
    const motor = await this.request(MSP.MOTOR_CONFIG).catch(() => undefined);
    if (motor && motor.length >= 7) this.motorCount = motor[6] || 4;
    const feature = await this.request(MSP.FEATURE_CONFIG).catch(() => undefined);
    if (feature?.length === 4) this.features = new Reader(feature).u32();
    const count = this.airframe().motors.length;
    this.identity.vehicle = count === 6 ? 'hex' : count === 8 ? 'octo' : count === 3 ? 'tri' : 'quad';
    await this.pollOnce(true);
  }

  // ---- Live readings ------------------------------------------------------------------------------------------

  private startPolling() {
    this.poll = setInterval(() => {
      if (this.pollBusy || this.mode !== 'msp' || this.closedReason) {
        if (this.mode === 'msp' && !this.closedReason && this.live.at && this.now() - this.live.at > 3500 && this.live.linkOk) { this.live.linkOk = false; this.emit({ type: 'state' }); }
        return;
      }
      this.pollBusy = true;
      void this.pollOnce(this.tickCount++ % 5 === 0).catch(() => {}).finally(() => { this.pollBusy = false; });
    }, this.timing.pollMs);
  }
  private async pollOnce(slow: boolean) {
    const att = new Reader(await this.request(MSP.ATTITUDE));
    this.live.attitude = { roll: att.i16() / 10, pitch: -att.i16() / 10, yaw: att.i16() };
    if (slow) {
      const s = new Reader(await this.request(MSP.STATUS_EX));
      s.skip(4);
      const sensors = s.u16(), flags = s.u32();
      s.skip(1);
      this.live.cpuLoad = s.u16();
      s.skip(2);
      const extra = s.u8() & 0x0f;
      s.skip(extra);
      const flagCount = s.u8(), disable = s.u32();
      this.live.armed = (flags & 1) === 1;
      this.live.mode = this.live.armed ? (flags & 2 ? 'Angle' : flags & 4 ? 'Horizon' : 'Acro') : 'Disarmed';
      for (const [bit, key] of SENSORS) this.live.sensors[key] = (sensors & bit ? 'ok' : key === 'gyro' ? 'bad' : 'absent') as Health;
      const names = ARMING_FLAGS.slice(0, flagCount).filter((_, i) => disable & (1 << i));
      this.live.armingBlocks = names.filter(n => !ARMING_EXPECTED.has(n)).map(n => ARMING_WORDS[n] ?? n);
      this.live.sensors.receiver = names.includes('RXLOSS') ? 'bad' : 'ok';
      const battery = await this.request(MSP.BATTERY_STATE).catch(() => undefined);
      if (battery && battery.length >= 9) {
        const b = new Reader(battery);
        const cells = b.u8(), capacity = b.u16(); b.skip(1);
        const drawn = b.u16(), amps = b.u16(); b.skip(1);
        const voltage = b.left >= 2 ? b.u16() / 100 : 0;
        this.live.battery = { voltage, current: amps / 100, cells: cells || undefined, remaining: capacity ? Math.max(0, Math.round(100 - (drawn / capacity) * 100)) : undefined };
      }
      const rc = await this.request(MSP.RC).catch(() => undefined);
      if (rc) { const r = new Reader(rc); const channels: number[] = []; while (r.left >= 2) channels.push(r.u16()); this.live.rc = { channels: this.live.sensors.receiver === 'bad' ? [] : channels }; }
      const motor = await this.request(MSP.MOTOR).catch(() => undefined);
      if (motor) { const r = new Reader(motor); const outputs: number[] = []; while (r.left >= 2 && outputs.length < this.airframe().motors.length) outputs.push(r.u16()); this.live.motors = { outputs }; }
      if (this.features & FEATURE_GPS) {
        const gps = await this.request(MSP.RAW_GPS).catch(() => undefined);
        if (gps && gps.length >= 16) { const r = new Reader(gps); const fix = r.u8(), sats = r.u8(), lat = r.i32() / 1e7, lon = r.i32() / 1e7; this.live.gps = { fix: fix ? 3 : 0, sats, ...(fix ? { lat, lon } : {}) }; }
      }
    }
    if (this.now() - this.lastEmit > 90 || slow) { this.lastEmit = this.now(); this.emit({ type: 'state' }); }
  }
  state() { return this.live; }
  airframe(): Airframe { return betaflightFrame(this.mixer, this.yawReversed, this.motorCount); }

  // ---- Console ------------------------------------------------------------------------------------------------

  private async readUntilPrompt(timeoutMs: number): Promise<string> {
    const end = this.now() + timeoutMs;
    for (;;) {
      if (this.closedReason) throw new DeviceError('disconnected', 'The flight controller disconnected.');
      if (/(^|\r?\n)# $/.test(this.cliText)) {
        const mark = this.cliText.length;
        await sleep(this.timing.cliIdleMs);
        if (this.cliText.length === mark) return this.cliText;
        continue;
      }
      if (this.now() > end) throw new DeviceError('timeout', 'The flight controller console did not answer.');
      await new Promise<void>(resolve => { const t = setTimeout(resolve, 50); this.cliWaiter = () => { clearTimeout(t); resolve(); }; });
    }
  }
  private async enterCli() {
    this.ready(false);
    if (this.live.armed) throw new DeviceError('blocked', 'The aircraft is armed. Disarm it first.');
    while (this.pollBusy) await sleep(10);
    this.mode = 'cli';
    this.cliText = '';
    await this.transport.write(Uint8Array.of(0x23));
    await this.readUntilPrompt(3000);
  }
  private async cli(command: string, timeoutMs = this.timing.cliMs): Promise<string> {
    if (/[\r\n#]/.test(command)) throw new DeviceError('invalid', 'Console command contains characters that are not allowed.');
    this.cliText = '';
    await this.transport.write(new TextEncoder().encode(`${command}\n`));
    const text = await this.readUntilPrompt(timeoutMs);
    return text.replace(/\r/g, '').replace(/\n# $/, '').split('\n').filter((line, i) => !(i === 0 && line.trim() === command)).join('\n').trim();
  }
  /** Leave the console without saving. Newer firmware stays up; older firmware restarts, and the runtime reconnects. */
  private async exitCli() {
    this.cliText = '';
    this.expectingReboot = true;
    await this.transport.write(new TextEncoder().encode('exit noreboot\n')).catch(() => {});
    await sleep(this.timing.cliIdleMs * 2);
    if (this.closedReason) return;
    this.mode = 'msp';
    this.msp.reset();
    const alive = await this.request(MSP.API_VERSION, undefined, this.timing.rebootMs).then(() => true, () => false);
    this.expectingReboot = false;
    if (!alive && !this.closedReason) { this.expectingReboot = true; await sleep(this.timing.rebootMs); this.expectingReboot = false; if (!this.closedReason) await this.request(MSP.API_VERSION).catch(() => {}); }
  }
  private async withCli<T>(fn: () => Promise<T>): Promise<T> {
    await this.enterCli();
    try { return await fn(); }
    finally { if (!this.closedReason && this.mode === 'cli') await this.exitCli(); }
  }

  // ---- Settings -----------------------------------------------------------------------------------------------

  settingsLoaded() { return this.loaded; }
  settings(): Setting[] {
    const out: Setting[] = [...this.values].map(([name, v]) => toSetting(name, v.value, v.scope, this.info.get(name), v.at));
    for (const [id, line] of this.lines) {
      const [, kind, key] = id.split('.');
      if (kind === 'feature') out.push({ id, name: `feature ${key}`, part: 'fc', group: 'Features', value: line.value, type: 'bool', options: [{ value: 'OFF', label: 'OFF' }, { value: 'ON', label: 'ON' }], title: `Feature ${key}`, at: line.at });
      else if (kind === 'serial') out.push({ id, name: `serial ${key}`, part: 'ports', group: 'Serial ports', value: line.value, type: 'text', title: `Port ${key}`, at: line.at,
        description: 'Function mask, then MSP, GPS, telemetry and blackbox baud rates. Mask bits: 1 MSP, 2 GPS, 64 serial receiver, 128 blackbox, 1024 ESC sensor, 2048 SmartAudio, 4096 Tramp, 131072 MSP displayport.' });
      else if (kind === 'aux') out.push({ id, name: `aux ${key}`, part: 'receiver', group: 'Modes', value: line.value, type: 'text', title: `Mode slot ${key}`, at: line.at,
        description: 'Mode id, aux channel (0 is AUX1), range start, range end, logic, linked mode. Mode ids: 0 arm, 1 angle, 2 horizon, 13 beeper, 26 blackbox, 27 failsafe, 28 air mode, 35 flip over after crash, 36 prearm.' });
      else if (kind === 'map') out.push({ id, name: 'map', part: 'receiver', group: 'Receiver', value: line.value, type: 'text', title: 'Channel map', at: line.at });
    }
    for (const read of this.escReads) if (read.block) out.push(...escSettings(read.info, read.block));
    if (this.vtx) this.decorateVtx(out);
    for (const s of out) if (/^bf\.osd_[a-z0-9_]+_pos$/.test(s.id) && typeof s.value === 'number') {
      const p = decodeOsd(s.value), key = s.id.slice(7, -4);
      s.part = 'osd'; s.group = 'OSD layout'; s.title = `${OSD_NAMES[key] ?? key.replace(/_/g, ' ')} position`;
      s.description = `Now at column ${p.x}, row ${p.y}, ${p.profiles & 1 ? 'shown' : 'hidden'}. Set "x,y", "x,y,on" or "x,y,off".`;
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  private async readVtx() {
    const text = await this.cli('vtxtable');
    this.vtx = /unknown|invalid|error/i.test(text) && !text.includes('vtxtable ') ? undefined : { table: parseVtxTable(text), at: this.now() };
  }
  /** Give band, channel and power their names and frequencies from the table, and add the table itself as a setting. */
  private decorateVtx(out: Setting[]) {
    const t = this.vtx!.table;
    const band = Number(out.find(s => s.id === 'bf.vtx_band')?.value ?? 0);
    out.push({ id: 'bf.vtxtable', name: 'vtxtable', part: 'vtx', group: 'Video', title: 'Video table', at: this.vtx!.at, type: 'enum', value: presetName(t),
      options: [...Object.keys(VTX_PRESETS), ...(presetName(t) === 'custom' ? ['custom'] : []), ...(t ? [] : ['none'])].map(v => ({ value: v, label: v })),
      description: 'Which frequencies and power levels the video transmitter offers. Choose the one matching your transmitter, or give a full table as JSON.' });
    if (!t) return;
    for (const s of out) {
      if (s.id === 'bf.vtx_band') { s.type = 'enum'; s.options = [{ value: 0, label: 'Set by frequency' }, ...t.bands.map(b => ({ value: b.number, label: `${b.letter} · ${b.name.replace('_', ' ').toLowerCase()}` }))]; }
      if (s.id === 'bf.vtx_channel') { s.type = 'enum'; s.options = Array.from({ length: t.channels }, (_, i) => ({ value: i + 1, label: `${i + 1}${frequency(t, band, i + 1) ? ` · ${frequency(t, band, i + 1)} MHz` : ''}` })); }
      if (s.id === 'bf.vtx_power') { s.type = 'enum'; s.options = t.powers.map((p, i) => ({ value: i + 1, label: `${p.label} mW` })); }
    }
  }
  /** The current video frequency, from the table, or the direct frequency setting. */
  videoFrequency(): number | undefined {
    const v = (n: string) => Number(this.values.get(n)?.value ?? 0);
    return v('vtx_band') ? frequency(this.vtx?.table, v('vtx_band'), v('vtx_channel')) : v('vtx_freq') || undefined;
  }
  private absorbDump(text: string) {
    const dump = parseDump(text), at = this.now();
    for (const s of dump.settings) this.values.set(s.name, { value: s.value, scope: s.scope, at });
    for (const [id, value] of Object.entries(dump.serial)) this.lines.set(`bf.serial.${id}`, { value, at });
    for (const [id, value] of Object.entries(dump.aux)) this.lines.set(`bf.aux.${id}`, { value, at });
    if (dump.map) this.lines.set('bf.map', { value: dump.map, at });
    if (dump.board && !this.identity.board) this.identity.board = dump.board;
  }
  private async readFeatures() {
    const enabled = new Set((await this.cli('feature')).replace(/^Enabled:\s*/i, '').split(/\s+/).filter(Boolean));
    const available = (await this.cli('feature list')).replace(/^Available:\s*/i, '').split(/\s+/).filter(n => /^[A-Z0-9_]+$/.test(n));
    const at = this.now();
    for (const name of new Set([...available, ...enabled])) this.lines.set(`bf.feature.${name}`, { value: enabled.has(name) ? 'ON' : 'OFF', at });
  }
  async loadSettings(progress?: RunContext['progress']) {
    await this.exclusive('reading settings', async () => {
      this.loaded = 'loading';
      try {
        await this.withCli(async () => {
          progress?.('Reading settings');
          this.absorbDump(await this.cli('dump', 30000));
          // `get` with no name lists every setting with its allowed values and range.
          progress?.('Reading allowed values');
          for (const info of parseGet(await this.cli('get', 30000))) this.info.set(info.name, info);
          await this.readFeatures();
          await this.readVtx();
          this.backup = await this.cli('diff all', 30000);
        });
        this.loaded = 'complete';
      } catch (error) { this.loaded = this.values.size ? 'partial' : 'none'; throw error; }
      finally { this.emit({ type: 'settings' }); }
    });
  }
  private async readLine(id: string): Promise<string | undefined> {
    const [, kind, key] = id.split('.');
    if (kind === 'feature') { await this.readFeatures(); return this.lines.get(id)?.value; }
    if (kind === 'map') { const m = (await this.cli('map')).match(/([A-Z]{4}\d{4})/); if (m) this.lines.set(id, { value: m[1], at: this.now() }); return m?.[1]; }
    const text = await this.cli(kind);
    for (const line of text.split('\n')) {
      const m = line.trim().match(kind === 'serial' ? /^serial (\S+) (.+)$/ : /^aux (\d+) (.+)$/);
      if (m) this.lines.set(`bf.${kind}.${m[1]}`, { value: m[2].trim(), at: this.now() });
    }
    return this.lines.get(`bf.${kind}.${key}`)?.value;
  }
  private isLine(id: string) { return /^bf\.(feature|serial|aux)\.[\w.]+$/.test(id) || id === 'bf.map'; }
  private async getOne(name: string): Promise<GetInfo> {
    const hit = parseGet(await this.cli(`get ${safeName(name)}`)).find(g => g.name === name);
    if (!hit) throw new DeviceError('invalid', `This firmware has no setting called ${name}.`);
    this.info.set(name, hit);
    this.values.set(name, { value: hit.value, scope: hit.scope ?? this.values.get(name)?.scope, at: this.now() });
    return hit;
  }
  async refresh(ids: string[]): Promise<Setting[]> {
    return this.exclusive('reading settings', async () => {
      const wanted = ids.filter(id => id.startsWith('bf.'));
      if (wanted.length) await this.withCli(async () => { for (const id of wanted) { if (this.isLine(id)) await this.readLine(id); else await this.getOne(id.slice(3)).catch(() => {}); } });
      this.emit({ type: 'settings', ids });
      const all = this.settings();
      return ids.flatMap(id => all.find(s => s.id === id) ?? []);
    });
  }
  async write(changes: Change[], ctx: RunContext): Promise<ChangeResult[]> {
    requireGrant(ctx, 'write', changes.some(c => c.id.startsWith('esc.')) ? ['propsRemoved', 'directUsb'] : []);
    return this.exclusive('writing settings', async () => {
      this.ready();
      const results: ChangeResult[] = [];
      const escChanges = changes.filter(c => c.id.startsWith('esc.'));
      const cliChanges = changes.filter(c => c.id.startsWith('bf.'));
      for (const c of changes.filter(c => !c.id.startsWith('esc.') && !c.id.startsWith('bf.'))) results.push({ id: c.id, before: null, requested: c.value, after: null, ok: false, note: 'Unknown setting.' });
      if (escChanges.length) { const { reads, results: r } = await writeEscChanges(this.session, ctx, this.now, escChanges, this.escReads); this.escReads = reads; results.push(...r); }
      if (cliChanges.length) {
        let wrote = 0;
        await this.enterCli();
        try {
          for (const change of cliChanges) {
            try {
              if (change.id === 'bf.vtxtable') {
                const before = presetName(this.vtx?.table);
                if (change.expected !== undefined && String(change.expected) !== before) throw new DeviceError('stale', `The video table is now ${before}, not ${change.expected}. Nothing was written.`);
                let table: VtxTable;
                if (typeof change.value === 'string' && VTX_PRESETS[change.value]) table = VTX_PRESETS[change.value];
                else { try { table = validateVtxTable(JSON.parse(String(change.value))); } catch (error) { throw error instanceof DeviceError ? error : new DeviceError('invalid', 'Choose a preset or give a table as JSON.', `Presets: ${Object.keys(VTX_PRESETS).join(', ')}.`); } }
                ctx.progress?.('Writing video table');
                for (const command of vtxTableCommands(table)) { const answer = await this.cli(command); if (/error|invalid/i.test(answer)) throw new DeviceError('rejected', `The flight controller refused: ${command}`); }
                await this.readVtx();
                const after = presetName(this.vtx?.table), ok = JSON.stringify(this.vtx?.table) === JSON.stringify(table);
                if (ok) wrote++;
                results.push({ id: change.id, before, requested: change.value, after, ok, note: ok ? 'Saved. The flight controller restarts to apply it.' : 'The flight controller kept a different table.' });
                continue;
              }
              const osd = /^bf\.osd_[a-z0-9_]+_pos$/.test(change.id);
              const value = osd ? String(parseOsdValue(change.value, Number(this.values.get(change.id.slice(3))?.value ?? 0))) : safeValue(change.value);
              let before: string | undefined, after: string | undefined, command: string;
              if (this.isLine(change.id)) {
                const [, kind, key] = change.id.split('.');
                before = await this.readLine(change.id);
                if (before === undefined) throw new DeviceError('invalid', `${change.id} does not exist on this flight controller.`);
                if (kind === 'feature' && !/^(ON|OFF)$/i.test(value)) throw new DeviceError('invalid', 'A feature is ON or OFF.');
                command = kind === 'feature' ? `feature ${/^on$/i.test(value) ? '' : '-'}${key}` : kind === 'map' ? `map ${value}` : `${kind} ${key} ${value}`;
              } else {
                const name = change.id.slice(3);
                before = (await this.getOne(name)).value;
                command = `set ${name} = ${value}`;
              }
              if (change.expected !== undefined && String(change.expected).toLowerCase() !== before.toLowerCase())
                throw new DeviceError('stale', `${change.id} is now ${before}, not ${change.expected}. Nothing was written.`);
              ctx.progress?.(`Writing ${change.id.slice(3)}`);
              const answer = await this.cli(command);
              if (/error|invalid|unknown|not found|out of range/i.test(answer) && !/ set to /i.test(answer)) {
                const info = this.info.get(change.id.slice(3));
                const allowed = info?.options ? `Allowed: ${info.options.join(', ')}.` : info?.min !== undefined ? `Allowed: ${info.min} to ${info.max}.` : undefined;
                throw new DeviceError('invalid', `The flight controller refused ${value} for ${change.id.slice(3)}.`, allowed);
              }
              after = this.isLine(change.id) ? await this.readLine(change.id) : (await this.getOne(change.id.slice(3))).value;
              const ok = after !== undefined && (after.toLowerCase() === (this.isLine(change.id) && change.id.includes('.feature.') ? value.toUpperCase() : value).toLowerCase() || Number(after) === Number(value));
              if (ok) wrote++;
              results.push({ id: change.id, before, requested: change.value, after: after ?? null, ok, note: ok ? 'Saved. The flight controller restarts to apply it.' : 'The flight controller kept a different value.' });
            } catch (error) {
              results.push({ id: change.id, before: null, requested: change.value, after: null, ok: false, note: error instanceof DeviceError && error.hint ? `${error.message} ${error.hint}` : error instanceof Error ? error.message : 'Write failed.' });
            }
          }
          if (wrote) {
            // `save` stores everything and restarts the flight controller. The port drops; the runtime reconnects and re-reads.
            this.expectingReboot = true;
            await this.transport.write(new TextEncoder().encode('save\n'));
            await sleep(this.timing.rebootMs);
            if (!this.closedReason) { this.mode = 'msp'; this.msp.reset(); this.expectingReboot = false; this.emit({ type: 'reconnect-needed', reason: 'The flight controller saved and restarted.' }); }
          } else await this.exitCli();
        } catch (error) { if (!this.closedReason && this.mode === 'cli') await this.exitCli(); throw error; }
      }
      this.emit({ type: 'settings', ids: changes.map(c => c.id) });
      return results;
    });
  }

  // ---- ESCs ---------------------------------------------------------------------------------------------------

  escs(): EscInfo[] { return this.escReads.map(r => r.info); }
  private session: EscSession = async (write, ctx, fn) => {
    this.ready();
    if (!this.live.battery || this.live.battery.voltage < 2) throw new DeviceError('blocked', 'The ESCs have no power.', 'Connect the flight battery with the props removed.');
    while (this.pollBusy) await sleep(10);
    this.mode = 'esc';
    const link = new FourWay({ write: bytes => this.transport.write(bytes), onData: listener => { this.raw.add(listener); return () => this.raw.delete(listener); } }, this.timing.esc);
    let entered = false;
    try {
      ctx.progress?.('Opening ESC passthrough');
      const count = (await link.msp(245))[0];
      entered = true;
      if (!(count >= 1 && count <= 8)) throw new DeviceError('mismatch', 'No ESCs answered.', 'Check the flight battery and the ESC signal wires.');
      await sleep(this.timing.esc.settleMs);
      link.allowWrites = write;
      return await fn(link, count);
    } finally {
      link.allowWrites = false;
      if (entered) await link.exit().catch(() => {});
      link.dispose();
      this.mode = 'msp';
      this.msp.reset();
    }
  };

  // ---- Tests and procedures -----------------------------------------------------------------------------------

  tests(): TestSpec[] {
    const motors = this.airframe().motors.length;
    return [
      { id: 'link.check', name: 'Link check', part: 'link', level: 0, seconds: 1, needs: [], proves: 'The flight controller is answering steadily over this connection.' },
      { id: 'sensors.check', name: 'Sensor health', part: 'fc', level: 0, seconds: 1, needs: [], proves: 'Which sensors the flight controller has detected.' },
      { id: 'prearm.check', name: 'Arming checks', part: 'safety', level: 0, seconds: 1, needs: [], proves: 'The flight controller would allow arming, or lists exactly why not.' },
      { id: 'radio.check', name: 'Radio check', part: 'receiver', level: 0, seconds: 1, needs: [], proves: 'The receiver is delivering stick and switch positions.' },
      { id: 'battery.check', name: 'Battery check', part: 'battery', level: 0, seconds: 1, needs: [], proves: 'Battery voltage is being measured and is in a believable range.' },
      { id: 'diagnostics.full', name: 'Full check', part: 'fc', level: 0, seconds: 3, needs: [], proves: 'Link, sensors, arming checks, radio and battery, in one pass.' },
      { id: 'settings.snapshot', name: 'Settings snapshot', part: 'fc', level: 0, seconds: 10, needs: [], proves: 'A complete copy of every setting, for backup or comparison.' },
      { id: 'settings.restore', name: 'Restore a backup', part: 'fc', level: 2, seconds: 30, needs: [], interactive: true, proves: 'Settings match a saved backup file.', args: [{ name: 'file', type: 'file', required: true }] },
      { id: 'logs.list', name: 'Check log storage', part: 'logging', level: 0, seconds: 1, needs: [], proves: 'How much of the onboard blackbox flash is used.' },
      { id: 'logs.analyze', name: 'Analyse a flight log', part: 'logging', level: 0, seconds: 60, needs: [], proves: 'Vibration, stick tracking, throttle and battery behaviour during a recorded flight.', args: [{ name: 'log', type: 'number', min: 1 }] },
      { id: 'logs.erase', name: 'Erase blackbox flash', part: 'logging', level: 2, seconds: 30, needs: [], proves: 'The onboard log storage is empty and ready to record.' },
      { id: 'receiver.bind', name: 'Put receiver in bind mode', part: 'receiver', level: 2, seconds: 5, needs: [], proves: 'An ExpressLRS receiver is waiting to bind. Afterwards, unplug and replug the flight controller.' },
      { id: 'receiver.flash', name: 'Flash receiver firmware', part: 'receiver', level: 3, seconds: 60, interactive: true, needs: ['firmwareMatchesBoard'], proves: 'An ExpressLRS receiver runs the chosen firmware, written through the flight controller.', args: [{ name: 'file', type: 'file', required: true }] },
      { id: 'esc.read', name: 'Read ESCs', part: 'motors', level: 2, seconds: 8, needs: ['propsRemoved', 'directUsb', 'batteryConnected'], proves: 'Firmware and settings of each ESC, including spin direction.' },
      { id: 'cal.accel', name: 'Accelerometer calibration', part: 'fc', level: 2, seconds: 4, needs: ['level', 'still'], proves: 'The flight controller knows which way is level.' },
      { id: 'cal.compass', name: 'Compass calibration', part: 'compass', level: 2, seconds: 30, needs: [], interactive: true, proves: 'Compass offsets are measured while you turn the aircraft through every direction.' },
      { id: 'fc.restart', name: 'Restart flight controller', part: 'fc', level: 2, seconds: 6, needs: [], proves: 'The flight controller restarted cleanly.' },
      { id: 'motor.spin', name: 'Motor spin', part: 'motors', level: 3, seconds: 2, needs: ['propsRemoved', 'areaClear'], proves: 'Which physical motor a number refers to, and which way it turns.',
        args: [{ name: 'motor', type: 'number', min: 1, max: motors, required: true }, { name: 'throttle', type: 'number', min: 3, max: 15, default: 5, unit: '%' }, { name: 'seconds', type: 'number', min: 0.5, max: 3, default: 1, unit: 's' }] },
      { id: 'esc.flash', name: 'Flash ESC firmware', part: 'motors', level: 3, seconds: 90, needs: ['propsRemoved', 'directUsb', 'batteryConnected', 'firmwareMatchesBoard'], interactive: true, proves: 'Each ESC runs the chosen firmware, verified by reading it back.',
        args: [{ name: 'esc', type: 'number', min: 1, max: 8 }, { name: 'file', type: 'file', required: true }] },
    ];
  }
  async enterBootloader() {
    this.ready();
    while (this.pollBusy) await sleep(10);
    await this.transport.write(encodeMsp(MSP.REBOOT, Uint8Array.of(1)));
    await sleep(this.timing.rebootMs);
  }
  async stop() {
    if (this.closedReason || this.mode !== 'msp') return;
    const w = new Writer();
    for (let i = 0; i < 8; i++) w.u16(1000);
    await this.request(MSP.SET_MOTOR, w.done()).catch(() => {});
  }
  private result(id: string, ok: boolean | null, summary: string, data?: unknown): TestResult { return { id, ok, summary, data, at: this.now() }; }
  private checks(): TestResult[] {
    const s = this.live, b = s.battery;
    const missing = Object.entries(s.sensors).filter(([k, v]) => v === 'bad' && k !== 'receiver').map(([k]) => k);
    const cells = b?.cells || (b ? Math.max(1, Math.round(b.voltage / 3.9)) : 0);
    const perCell = b && cells ? b.voltage / cells : 0;
    return [
      this.result('sensors.check', missing.length === 0, missing.length ? `Not detected: ${missing.join(', ')}.` : `Detected: ${Object.entries(s.sensors).filter(([k, v]) => v === 'ok' && k !== 'receiver').map(([k]) => k).join(', ')}.`, s.sensors),
      !b ? this.result('battery.check', null, 'No battery reading yet.') : b.voltage < 2 ? this.result('battery.check', null, 'USB power only; the flight battery is not connected.', b)
        : this.result('battery.check', perCell >= 3.3 && perCell <= 4.4, `${round(b.voltage, 2)} V, about ${round(perCell, 2)} V per cell across ${cells} cells.`, b),
      s.sensors.receiver === 'bad' || !s.rc?.channels.length ? this.result('radio.check', false, 'No signal from the receiver. Switch the transmitter on and check the receiver wiring and protocol.')
        : this.result('radio.check', true, `${s.rc.channels.length} channels arriving.`, s.rc),
      this.result('prearm.check', s.armingBlocks.length === 0, s.armingBlocks.length ? `Will not arm: ${s.armingBlocks.join('; ')}.` : 'Nothing is blocking arming, apart from this connection itself.', { blocks: s.armingBlocks }),
    ];
  }
  async run(id: string, ctx: RunContext = {}): Promise<TestResult> {
    const spec = this.tests().find(t => t.id === id);
    if (!spec) throw new DeviceError('unsupported', `There is no test "${id}" on this aircraft.`);
    if (spec.level > 0) requireGrant(ctx, id, spec.needs);
    const args = ctx.args ?? {};
    const num = (name: string) => { const a = spec.args!.find(x => x.name === name)!; const v = args[name] === undefined ? a.default : Number(args[name]); if (v === undefined || !Number.isFinite(Number(v)) || Number(v) < a.min! || Number(v) > a.max!) throw new DeviceError('invalid', `${name} must be from ${a.min} to ${a.max}.`); return Number(v); };
    switch (id) {
      case 'link.check': {
        const start = this.now();
        const ok = await this.request(MSP.API_VERSION).then(() => true, () => false);
        return this.result(id, ok, ok ? `Answered in ${this.now() - start} ms.` : 'The flight controller did not answer.', { roundTripMs: this.now() - start });
      }
      case 'sensors.check': case 'battery.check': case 'radio.check': case 'prearm.check': await this.pollOnce(true).catch(() => {}); return this.checks().find(c => c.id === id)!;
      case 'diagnostics.full': {
        await this.pollOnce(true).catch(() => {});
        const parts = this.checks();
        const failed = parts.filter(p => p.ok === false), unknown = parts.filter(p => p.ok === null);
        return this.result(id, failed.length ? false : unknown.length ? null : true,
          failed.length ? `${failed.length} problem${failed.length > 1 ? 's' : ''}: ${failed.map(p => p.summary).join(' ')}` : unknown.length ? `No problems found. ${unknown.length} check${unknown.length > 1 ? 's' : ''} could not be completed.` : 'Everything checked is healthy.',
          parts.map(({ id: check, ok, summary }) => ({ check, ok, summary })));
      }
      case 'settings.snapshot': {
        if (this.loaded !== 'complete') await this.loadSettings(ctx.progress);
        const values = Object.fromEntries(this.settings().filter(s => s.id.startsWith('bf.')).map(s => [s.id.slice(3), s.value]));
        return this.result(id, true, `${Object.keys(values).length} settings captured.`, { stack: this.identity.stack, version: this.identity.version, values, backup: this.backup });
      }
      case 'settings.restore': return this.exclusive('restoring a backup', async () => {
        this.ready();
        const file = await ctx.prompt?.({ kind: 'file', label: 'Choose a Betaflight backup (diff all)', accept: '.txt' });
        if (!(file instanceof Uint8Array)) throw new DeviceError('invalid', 'No backup file was chosen.');
        const { lines, rejected } = restoreLines(new TextDecoder().decode(file));
        if (!lines.length) throw new DeviceError('invalid', 'That file has no settings Lucidity recognises.');
        if (rejected.length) throw new DeviceError('invalid', `The file contains ${rejected.length} line${rejected.length > 1 ? 's' : ''} that are not settings. Nothing was written.`, `First: "${rejected[0].slice(0, 60)}"`);
        await this.enterCli();
        const errors: string[] = [];
        for (const [i, line] of lines.entries()) {
          ctx.progress?.('Restoring settings', i, lines.length);
          const answer = await this.cli(line);
          if (/error|invalid/i.test(answer) && !/ set to /i.test(answer)) errors.push(line);
        }
        this.expectingReboot = true;
        await this.transport.write(new TextEncoder().encode('save\n'));
        await sleep(this.timing.rebootMs);
        if (!this.closedReason) { this.mode = 'msp'; this.msp.reset(); this.expectingReboot = false; this.emit({ type: 'reconnect-needed', reason: 'The flight controller saved and restarted.' }); }
        return this.result(id, errors.length === 0, errors.length ? `${lines.length - errors.length} of ${lines.length} lines applied. ${errors.length} were refused.` : `${lines.length} lines applied and saved.`, { applied: lines.length - errors.length, refused: errors.slice(0, 20) });
      });
      case 'logs.list': return this.exclusive('checking logs', async () => {
        const f = await this.flashSummary();
        return this.result(id, true, f.used ? `${Math.round(f.used / 1024)} KB of ${Math.round(f.total / 1024)} KB used${this.flash ? `, ${this.flash.logs.length} flight${this.flash.logs.length === 1 ? '' : 's'} downloaded` : ''}.` : 'The log storage is empty.', { ...f, logs: this.logs() });
      });
      case 'logs.analyze': return this.exclusive('downloading logs', async () => {
        if (!this.flash) await this.downloadFlash(ctx);
        const logs = this.flash!.logs;
        if (!logs.length) throw new DeviceError('invalid', 'No flights were found in the log storage.');
        const wanted = args.log === undefined ? logs.length : Number(args.log);
        const log = logs[wanted - 1];
        if (!log) throw new DeviceError('invalid', `There is no flight ${wanted}.`, `Available: 1 to ${logs.length}.`);
        this.analysed = { id: wanted, analysis: analyzeBlackbox(log) };
        this.emit({ type: 'settings' });
        return this.result(id, true, `Flight ${wanted} of ${logs.length} analysed (${Math.round(log.stats.bytes / 1024)} KB, ${log.frames.length} samples).`, { log: wanted, analysis: this.analysed.analysis });
      });
      case 'logs.erase': return this.exclusive('erasing logs', async () => {
        this.ready();
        await this.request(MSP.DATAFLASH_ERASE, undefined, 4000);
        const end = this.now() + 120_000;
        for (;;) {
          await sleep(Math.min(500, this.timing.pollMs * 5));
          const f = await this.flashSummary().catch(() => undefined);
          if (f?.ready && f.used === 0) break;
          if (this.now() > end) throw new DeviceError('timeout', 'Erasing did not finish in two minutes.');
        }
        this.flash = undefined; this.analysed = undefined;
        this.emit({ type: 'settings' });
        return this.result(id, true, 'Log storage erased.');
      });
      case 'receiver.bind': return this.exclusive('binding', async () => {
        await this.openReceiverPassthrough();
        await this.transport.write(elrsCommand('bind'));
        await sleep(this.timing.cliIdleMs * 4);
        await this.endPassthrough('Receiver is in bind mode. Bind from your transmitter, then unplug and replug the flight controller.');
        return this.result(id, null, 'The receiver was told to enter bind mode. Bind it from your transmitter, then unplug and replug the flight controller.');
      });
      case 'receiver.flash': return this.exclusive('flashing the receiver', async () => {
        const file = await ctx.prompt?.({ kind: 'file', label: 'Choose the receiver firmware (.bin)', accept: '.bin' });
        if (!(file instanceof Uint8Array)) throw new DeviceError('invalid', 'No firmware file was chosen.');
        checkEspImage(file, 0, 'ESP8266');
        await this.openReceiverPassthrough();
        const loader = new EspLoader({ ...this.transport, write: b => this.transport.write(b), onData: l => { this.raw.add(l); return () => this.raw.delete(l); }, onClose: l => this.transport.onClose(l), close: () => this.transport.close(), label: this.transport.label, open: true });
        try {
          // ExpressLRS's own sequence: a ROM training frame, then its "reboot to bootloader" command, then the ROM loader.
          await this.transport.write(SYNC_FRAME);
          await sleep(200);
          await this.transport.write(elrsCommand('bootloader', 'ESP82'));
          await sleep(300);
          await loader.sync();
          const chip = await loader.detect();
          checkEspImage(file, 0, chip);
          const written = await loader.flash(file, 0, ctx.progress);
          await loader.finish();
          await this.endPassthrough('Receiver flashed. Unplug the flight controller and plug it back in.');
          return this.result(id, written.verified ? true : null, written.verified ? `${chip} receiver flashed and verified.` : `${chip} receiver flashed. This chip's loader cannot read back, so check the receiver's light and bind it to confirm.`, { chip, bytes: written.bytes, verified: written.verified });
        } finally { loader.dispose(); }
      });
      case 'esc.read': return this.exclusive('reading ESCs', async () => { const { reads, result } = await readAllEscs(this.session, ctx, this.now); this.escReads = reads; this.emit({ type: 'settings' }); return result; });
      case 'esc.flash': return this.exclusive('flashing ESCs', async () => { const { reads, result } = await flashEscs(this.session, ctx, this.now, args.esc === undefined ? undefined : Number(args.esc), this.escReads); this.escReads = reads; this.emit({ type: 'settings' }); return result; });
      case 'cal.accel': return this.exclusive('calibrating', async () => { this.ready(); await this.request(MSP.ACC_CALIBRATION, undefined, 4000); await sleep(Math.min(2500, this.timing.rebootMs)); return this.result(id, true, 'Accelerometer calibration finished.'); });
      case 'cal.compass': return this.exclusive('calibrating', async () => {
        this.ready();
        if (this.live.sensors.compass !== 'ok') throw new DeviceError('unsupported', 'This aircraft has no compass.');
        await this.request(MSP.MAG_CALIBRATION, undefined, 4000);
        for (let i = 0; i < 30; i++) { ctx.progress?.('Turn the aircraft through every direction', i, 30); await sleep(Math.min(1000, this.timing.pollMs * 2)); }
        return this.result(id, null, 'Compass calibration window finished. Check the heading against a known direction.');
      });
      case 'fc.restart': return this.exclusive('restarting', async () => {
        this.ready();
        while (this.pollBusy) await sleep(10);
        this.expectingReboot = true;
        await this.transport.write(encodeMsp(MSP.REBOOT, Uint8Array.of(0)));
        await sleep(this.timing.rebootMs);
        if (!this.closedReason) this.emit({ type: 'reconnect-needed', reason: 'The flight controller is restarting.' });
        return this.result(id, true, 'Restart sent. Reconnecting.');
      });
      case 'motor.spin': return this.exclusive('motor test', async () => {
        this.ready();
        if (this.features & FEATURE_3D) throw new DeviceError('unsupported', 'Motor test is not offered while 3D mode is on, because stop is not at the bottom of the range.');
        const motor = num('motor'), throttle = num('throttle'), seconds = num('seconds');
        const w = new Writer();
        for (let i = 0; i < 8; i++) w.u16(i === motor - 1 ? 1000 + Math.round(throttle * 10) : 1000);
        await this.request(MSP.SET_MOTOR, w.done());
        try { await sleep(seconds * 1000); } finally { await this.stop(); }
        return this.result(id, null, `Motor ${motor} was commanded to ${throttle}% for ${seconds} s. Confirm by eye which motor turned and which way.`, { motor, throttle, seconds });
      });
      default: throw new DeviceError('unsupported', `"${id}" is not implemented.`);
    }
  }
  /** Find the receiver's UART and bridge USB straight to it. The flight controller stays like this until it is power-cycled. */
  private async openReceiverPassthrough() {
    this.ready();
    await this.enterCli();
    const provider = parseGet(await this.cli('get serialrx_provider')).find(g => g.name === 'serialrx_provider')?.value;
    if (provider !== 'CRSF' && provider !== 'ELRS') { await this.exitCli(); throw new DeviceError('unsupported', 'The receiver is not set up as CRSF, so it is not an ExpressLRS receiver on a serial port.', 'Set bf.serialrx_provider to CRSF first.'); }
    const port = (await this.cli('serial')).split('\n').map(l => l.trim().match(/^serial (\S+) (\d+) /)).find(m => m && (Number(m[2]) & 64))?.[1];
    if (!port) { await this.exitCli(); throw new DeviceError('unsupported', 'No serial port is set as the receiver.', 'Turn on "serial receiver" for the receiver UART in Ports.'); }
    this.cliText = '';
    this.mode = 'passthrough';
    await this.transport.write(new TextEncoder().encode(`serialpassthrough ${port} 420000\n`));
    await sleep(Math.max(200, this.timing.cliIdleMs * 4));
  }
  private async endPassthrough(reason: string) {
    this.expectingReboot = false;
    clearInterval(this.poll);
    this.emit({ type: 'closed', reason });
    await this.close();
  }
  logs(): LogEntry[] { return this.flash?.logs.map(l => ({ id: l.index, size: l.stats.bytes })) ?? []; }
  lastLogAnalysis() { return this.analysed; }
  private async flashSummary() {
    const r = new Reader(await this.request(MSP.DATAFLASH_SUMMARY));
    const flags = r.u8(), sectors = r.u32(), total = r.u32(), used = r.u32();
    if (!(flags & 2)) throw new DeviceError('unsupported', 'This flight controller has no onboard log flash.', 'If it logs to an SD card, copy the .bbl file off the card and open it in Flights.');
    return { ready: (flags & 1) === 1, sectors, total, used };
  }
  /** Read the used part of the log flash in 4 KB pieces over MSP v2, then split it into flights. */
  private async downloadFlash(ctx: RunContext) {
    this.ready(false);
    const f = await this.flashSummary();
    if (!f.used) throw new DeviceError('invalid', 'The log storage is empty.', 'Fly with blackbox logging on, then try again.');
    const bytes = new Uint8Array(f.used);
    for (let at = 0; at < f.used;) {
      if (ctx.signal?.aborted) throw new DeviceError('rejected', 'Download cancelled.');
      const size = Math.min(4096, f.used - at);
      const w = new Writer().u32(at).u16(size).u8(0).done();
      const r = new Reader(await this.request(MSP.DATAFLASH_READ, w, 3000, true));
      const address = r.u32(), length = r.u16(), compression = r.u8();
      if (address !== at || compression !== 0 || length === 0) throw new DeviceError('mismatch', 'The flight controller sent an unexpected piece of the log.');
      bytes.set(r.bytesOf(Math.min(length, f.used - at)), at);
      at += length;
      ctx.progress?.('Downloading logs', at, f.used);
    }
    this.flash = { bytes, logs: decodeAll(bytes) };
  }
}
