import { BetaflightDriver, type BfTiming } from './betaflight/driver';
import { DeviceError, sleep } from './bytes';
import type { DfuPort } from './flash/dfu';
import { dfuFlash } from './flash/dfu';
import { parseIntelHex } from './flash/hex';
import { parseApj, px4Flash } from './flash/px4';
import { MavlinkParser } from './mavlink/codec';
import { MavlinkDriver, requireGrant, type MavTiming } from './mavlink/driver';
import { encodeMsp, MSP, MspParser } from './msp/codec';
import type { PortSource } from './sim/demo';
import type { ByteTransport } from './transport';
import type { Airframe, Change, ChangeResult, Condition, Driver, EscInfo, Grant, Identity, LiveState, LogEntry, PromptRequest, Setting, TestResult, TestSpec } from './types';

/**
 * The one object that owns the connection to an aircraft. The UI calls it directly; requests from an assistant
 * arrive through `remote`, which has no way to carry an approval. Only `approve`, called from a click in this
 * tab, can produce the grant that a hardware write needs.
 */
export type RuntimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';
export interface AircraftSnapshot {
  status: RuntimeStatus; label?: string; demo?: boolean;
  identity?: Identity; state?: LiveState; airframe?: Airframe;
  settingsLoaded: 'none' | 'loading' | 'partial' | 'complete'; settingsCount: number;
  tests: TestSpec[]; escs: EscInfo[]; logs: LogEntry[]; busy?: string;
}
export type RuntimeEvent =
  | { type: 'status' } | { type: 'state' } | { type: 'settings'; ids?: string[] }
  | { type: 'progress'; label: string; done?: number; total?: number };
export type RemoteRequest =
  | { op: 'load' } | { op: 'refresh'; ids: string[] } | { op: 'run'; id: string; args?: Record<string, unknown> } | { op: 'stop' };
export interface RuntimeOptions { mav?: Partial<MavTiming>; bf?: Partial<BfTiming>; detectMs?: number; reconnectMs?: number; now?: () => number }

const FLASH: TestSpec = {
  id: 'firmware.flash', name: 'Flash flight controller firmware', part: 'fc', level: 3, seconds: 120, interactive: true,
  needs: ['propsRemoved', 'batteryDisconnected', 'firmwareMatchesBoard'], args: [{ name: 'file', type: 'file', required: true }],
  proves: 'The flight controller runs the chosen firmware, verified by reading it back or by checksum.',
};

/** Decide which protocol a freshly opened port speaks: listen for MAVLink, then ask in MSP. */
export async function detect(transport: ByteTransport, totalMs = 5000): Promise<'mavlink' | 'msp'> {
  const mav = new MavlinkParser(), msp = new MspParser();
  let found: 'mavlink' | 'msp' | undefined;
  const off = transport.onData(chunk => {
    if (mav.push(chunk).some(p => p.name === 'HEARTBEAT')) found ??= 'mavlink';
    if (msp.push(chunk).some(f => f.direction === '>' && f.command === MSP.API_VERSION)) found ??= 'msp';
  });
  try {
    const end = Date.now() + totalMs;
    let asked = 0;
    while (!found && Date.now() < end && transport.open) {
      const elapsed = totalMs - (end - Date.now());
      // An autopilot streams heartbeats unprompted; give it a moment before sending anything in another protocol.
      if (elapsed > Math.min(1200, totalMs / 4) * (asked + 1) && asked < 3) { asked++; await transport.write(encodeMsp(MSP.API_VERSION)).catch(() => {}); }
      await sleep(20);
    }
  } finally { off(); }
  if (!found) throw new DeviceError('timeout', 'Nothing on this port answered as a flight controller.', 'Check the cable carries data, and that you chose the flight controller.');
  return found;
}

export class Runtime {
  status: RuntimeStatus = 'idle';
  driver?: Driver;
  private source?: PortSource;
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private grants = new WeakSet<Grant>();
  private offDriver?: () => void;
  private rebootExpected = false;
  private now: () => number;
  constructor(private options: RuntimeOptions = {}) { this.now = options.now ?? Date.now; }

  on(listener: (event: RuntimeEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: RuntimeEvent) { for (const l of [...this.listeners]) l(event); }
  private setStatus(status: RuntimeStatus) { if (status !== this.status) { this.status = status; this.emit({ type: 'status' }); } }
  private need(): Driver {
    if (!this.driver || this.status !== 'connected') throw new DeviceError('disconnected', this.status === 'reconnecting' ? 'The flight controller is restarting.' : 'No aircraft is connected.', 'Open Armable and connect the drone.');
    return this.driver;
  }

  // ---- Connection ---------------------------------------------------------------------------------------------

  async connect(source: PortSource) {
    if (this.status !== 'idle') await this.disconnect();
    this.source = source;
    this.setStatus('connecting');
    try { await this.open(); }
    catch (error) { this.source = undefined; this.setStatus('idle'); throw error; }
  }
  private async open() {
    const transport = await this.source!.open();
    try {
      const protocol = await detect(transport, this.options.detectMs);
      this.adopt(protocol === 'mavlink'
        ? await MavlinkDriver.connect(transport, { timing: this.options.mav, now: this.now })
        : await BetaflightDriver.connect(transport, { timing: this.options.bf, now: this.now }));
    } catch (error) { await transport.close().catch(() => {}); throw error; }
  }
  private adopt(driver: Driver) {
    this.offDriver?.();
    this.driver = driver;
    this.rebootExpected = false;
    this.offDriver = driver.on(event => {
      if (event.type === 'state') this.emit({ type: 'state' });
      else if (event.type === 'settings') this.emit(event);
      else if (event.type === 'progress') this.emit(event);
      else if (event.type === 'reconnect-needed') { this.rebootExpected = true; this.setStatus('reconnecting'); }
      else if (event.type === 'closed' && this.driver === driver) void this.lost();
    });
    this.setStatus('connected');
    this.emit({ type: 'settings' });
  }
  private async lost() {
    const expected = this.rebootExpected;
    this.offDriver?.();
    const previous = this.driver;
    this.driver = undefined;
    if (!expected || !this.source) { this.setStatus('idle'); return; }
    this.setStatus('reconnecting');
    const end = Date.now() + (this.options.reconnectMs ?? 20000);
    while (Date.now() < end && this.source && this.status === 'reconnecting') {
      await sleep(Math.min(400, (this.options.reconnectMs ?? 20000) / 20));
      try { await this.open(); if (previous && this.driver) this.emit({ type: 'settings' }); return; } catch { /* not back yet */ }
    }
    if (this.status === 'reconnecting') this.setStatus('idle');
  }
  /** Resolves when a restart has finished and the aircraft is answering again. */
  private async reconnected() {
    const end = Date.now() + (this.options.reconnectMs ?? 20000) + 2000;
    while (Date.now() < end) { if (this.status === 'connected' && this.driver) return this.driver; if (this.status === 'idle') break; await sleep(20); }
    throw new DeviceError('disconnected', 'The flight controller did not come back after restarting.', 'Reconnect it, then read the settings again to confirm what was saved.');
  }
  async disconnect() {
    this.source = undefined;
    this.rebootExpected = false;
    const driver = this.driver;
    this.driver = undefined;
    this.offDriver?.();
    await driver?.close();
    this.setStatus('idle');
  }

  // ---- Approval -----------------------------------------------------------------------------------------------

  /** Mint a single-use grant. Call this only from a click handler in the bench tab. */
  approve(operation: string, conditions: Condition[] = []): Grant {
    const grant: Grant = Object.freeze({ operation, conditions: Object.freeze([...conditions]) });
    this.grants.add(grant);
    return grant;
  }
  private consume(grant: Grant | undefined, operation: string): Grant {
    if (!grant || !this.grants.has(grant)) throw new DeviceError('not_approved', 'This needs approval from the person at the aircraft.', 'Use propose_change or run_test and wait for approval in Armable.');
    if (grant.operation !== operation) throw new DeviceError('not_approved', 'The approval was given for a different operation.');
    this.grants.delete(grant);
    return grant;
  }

  // ---- Reads --------------------------------------------------------------------------------------------------

  snapshot(): AircraftSnapshot {
    const d = this.driver;
    return {
      status: this.status, label: this.source?.label, demo: this.source?.demo,
      identity: d?.identity, state: d?.state(), airframe: d?.airframe(),
      settingsLoaded: d?.settingsLoaded() ?? 'none', settingsCount: d?.settings().length ?? 0,
      tests: this.tests(), escs: d?.escs() ?? [], logs: d?.logs() ?? [],
    };
  }
  settings(): Setting[] { return this.driver?.settings() ?? []; }
  tests(): TestSpec[] { return this.driver ? [...this.driver.tests(), ...(this.driver.enterBootloader ? [FLASH] : [])] : []; }
  private loading?: Promise<void>;
  /** Read every setting. A second caller while a read is running shares it instead of being told "busy". */
  async load() {
    const driver = this.need();
    if (!this.loading) this.loading = driver.loadSettings((label, done, total) => this.emit({ type: 'progress', label, done, total })).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  /** After a restart the new connection knows no settings yet; read them again so everyone sees the full list. */
  private async reloadIfNeeded() {
    if (this.driver && this.status === 'connected' && this.driver.settingsLoaded() !== 'complete') await this.load().catch(() => {});
  }
  async refresh(ids: string[]) { return this.need().refresh(ids); }
  lastLogAnalysis() { return this.driver?.lastLogAnalysis(); }

  // ---- Writes and procedures ----------------------------------------------------------------------------------

  private progress = (label: string, done?: number, total?: number) => this.emit({ type: 'progress', label, done, total });
  /** Write settings, then confirm by reading back. If the flight controller restarts to save, the readback happens after it returns. */
  async write(changes: Change[], grant: Grant | undefined): Promise<ChangeResult[]> {
    const driver = this.need();
    const g = this.consume(grant, 'write');
    const results = await driver.write(changes, { grant: g, progress: this.progress });
    if (this.rebootExpected || this.status === 'reconnecting') {
      const saved = results.filter(r => r.ok);
      try {
        const fresh = await (await this.reconnected()).refresh(saved.map(r => r.id));
        for (const r of saved) {
          // Compare with what the flight controller read back before saving: the request may have been written in
          // another form (an option label, "x,y,on" for an OSD position, a video table preset name).
          const before = r.after, now = fresh.find(x => x.id === r.id);
          const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase() || (a !== null && b !== null && String(a).trim() !== '' && Number(a) === Number(b));
          r.after = now?.value ?? null;
          r.ok = now !== undefined && same(now.value, before);
          r.note = r.ok ? 'Saved and confirmed after the restart.' : 'The value did not survive the restart.';
        }
      } catch (error) { for (const r of saved) { r.ok = false; r.note = error instanceof Error ? error.message : 'Could not confirm after the restart.'; } }
      await this.reloadIfNeeded();
    }
    this.emit({ type: 'settings', ids: changes.map(c => c.id) });
    return results;
  }
  async run(id: string, args: Record<string, unknown> = {}, grant?: Grant, prompt?: (request: PromptRequest) => Promise<unknown>): Promise<TestResult> {
    const driver = this.need();
    const spec = this.tests().find(t => t.id === id);
    if (!spec) throw new DeviceError('unsupported', `There is no test "${id}" on this aircraft.`, `Use find to see what this aircraft offers.`);
    const g = spec.level > 0 ? this.consume(grant, id) : undefined;
    if (id === 'firmware.flash') return this.flash(driver, g!, prompt);
    const result = await driver.run(id, { args, grant: g, prompt, progress: this.progress });
    if (this.rebootExpected && id !== 'fc.restart') { await this.reconnected().catch(() => {}); await this.reloadIfNeeded(); }
    if (id === 'fc.restart') { await this.reconnected(); await this.reloadIfNeeded(); return { ...result, summary: 'Restarted and reconnected.' }; }
    return result;
  }
  private async flash(driver: Driver, grant: Grant, prompt?: (request: PromptRequest) => Promise<unknown>): Promise<TestResult> {
    requireGrant({ grant }, 'firmware.flash', FLASH.needs);
    if (!prompt) throw new DeviceError('invalid', 'Flashing needs a person to choose the firmware file.');
    const mavlink = driver.identity.stack === 'ardupilot' || driver.identity.stack === 'px4';
    const file = await prompt({ kind: 'file', label: mavlink ? 'Choose the firmware (.apj or .px4)' : 'Choose the firmware (.hex)', accept: mavlink ? '.apj,.px4' : '.hex' });
    if (!(file instanceof Uint8Array)) throw new DeviceError('invalid', 'No firmware file was chosen.');
    // Parse first: a bad file must be refused while the flight controller is still running normally.
    const apj = mavlink ? await parseApj(file) : undefined;
    const segments = mavlink ? undefined : parseIntelHex(new TextDecoder().decode(file));
    const source = this.source;
    this.source = undefined; // Do not auto-reconnect while the bootloader owns the device.
    await driver.enterBootloader!();
    await driver.close();
    this.driver = undefined; this.setStatus('idle');
    let summary: string, data: unknown;
    if (apj) {
      const port = await prompt({ kind: 'serial', label: 'Choose the flight controller again (it is now in firmware-update mode)' }) as ByteTransport | undefined;
      if (!port || typeof port.write !== 'function') throw new DeviceError('invalid', 'The flight controller was not chosen. It is waiting in firmware-update mode; unplug it to restart it.');
      try { data = await px4Flash(port, apj, this.progress); } finally { await port.close().catch(() => {}); }
      summary = `Firmware written and checksum confirmed (${Math.round(apj.image.length / 1024)} KB).`;
    } else {
      const port = await prompt({ kind: 'dfu', label: 'Choose "STM32 BOOTLOADER"' }) as DfuPort | undefined;
      if (!port || typeof port.out !== 'function') throw new DeviceError('invalid', 'The bootloader was not chosen. The flight controller is waiting in firmware-update mode; unplug it to restart it.');
      try { data = await dfuFlash(port, segments!, this.progress); } finally { await port.close().catch(() => {}); }
      summary = 'Firmware written and read back correctly.';
    }
    this.source = source;
    return { id: 'firmware.flash', ok: true, at: this.now(), summary: `${summary} Reconnect the flight controller.`, data };
  }
  /** Stop anything that is moving. Always allowed, for everyone. */
  async stop() { await this.driver?.stop(); }

  // ---- Requests relayed from an assistant ----------------------------------------------------------------------

  /** Everything an assistant can make the hardware do directly. There is deliberately no way to pass a grant here. */
  async remote(request: RemoteRequest): Promise<unknown> {
    switch (request.op) {
      case 'load': await this.load(); return { settingsLoaded: this.driver?.settingsLoaded(), count: this.settings().length };
      case 'refresh': return this.refresh(request.ids);
      case 'stop': await this.stop(); return { stopped: true };
      case 'run': {
        const spec = this.tests().find(t => t.id === request.id);
        if (spec && spec.level > 0) throw new DeviceError('not_approved', `"${request.id}" needs approval from the person at the aircraft.`, 'Call run_test; it creates a proposal for them to approve.');
        return this.run(request.id, request.args ?? {});
      }
      default: throw new DeviceError('unsupported', 'Unknown request.');
    }
  }
}
