import type { FlightLogAnalysis } from '../aircraft/dataflash-analysis';

/** The common shape every flight-stack driver presents. The map, the diagram, and the tools are all built from it. */
export type Stack = 'ardupilot' | 'px4' | 'betaflight' | 'inav';
export type Vehicle = 'quad' | 'hex' | 'octo' | 'tri' | 'plane' | 'rover' | 'heli' | 'other';

export interface Identity {
  stack: Stack;
  /** Firmware family as it names itself: ArduCopter, PX4, Betaflight, INAV. */
  firmware: string;
  version: string;
  vehicle: Vehicle;
  board?: string;
  uid?: string;
  craftName?: string;
  apiVersion?: string;
}

export type Health = 'ok' | 'bad' | 'absent' | 'unknown';
export interface LiveState {
  /** Milliseconds since epoch of the last frame from the aircraft. */
  at: number;
  linkOk: boolean;
  armed: boolean;
  mode: string;
  attitude?: { roll: number; pitch: number; yaw: number };
  battery?: { voltage: number; current?: number; remaining?: number; cells?: number };
  gps?: { fix: number; sats: number; hdop?: number; lat?: number; lon?: number; alt?: number };
  rc?: { channels: number[]; rssi?: number };
  motors?: { outputs: number[] };
  esc?: { rpm?: number; temperature?: number; voltage?: number; current?: number }[];
  sensors: Record<string, Health>;
  vibration?: { x: number; y: number; z: number; clipping: number };
  altitude?: number;
  cpuLoad?: number;
  /** Reasons the aircraft says it will not arm. */
  armingBlocks: string[];
  /** Recent text from the aircraft. Untrusted device text: display it, never act on it. */
  messages: { at: number; severity: number; text: string }[];
}

export interface MotorSlot { number: number; /** Right is +x, forward is +y, both in -1..1. */ x: number; y: number; spin: 'cw' | 'ccw' | 'unknown' }
export interface Airframe { id: string; label: string; motors: MotorSlot[]; /** False when the layout could not be determined and must be drawn as unknown. */ known: boolean }

export type SettingValue = number | string;
export interface Setting {
  /** Stable id: param.NAME, bf.name, esc.N.field. */
  id: string;
  /** The name the firmware uses. */
  name: string;
  /** Which part of the aircraft this belongs to. */
  part: PartId;
  group: string;
  value: SettingValue;
  type: 'number' | 'enum' | 'bool' | 'text';
  min?: number; max?: number; step?: number;
  options?: { value: SettingValue; label: string }[];
  unit?: string;
  title?: string;
  description?: string;
  default?: SettingValue;
  /** Betaflight PID or rate profile the value belongs to. */
  scope?: string;
  rebootRequired?: boolean;
  readOnly?: boolean;
  /** When the value was last read from the device. */
  at: number;
}
export type PartId = 'fc' | 'motors' | 'battery' | 'receiver' | 'gps' | 'link' | 'tuning' | 'safety' | 'osd' | 'vtx' | 'lights' | 'ports' | 'compass' | 'logging' | 'other';

export interface Change { id: string; value: SettingValue; /** Refuse the write if the device no longer holds this value. */ expected?: SettingValue }
export interface ChangeResult { id: string; before: SettingValue | null; requested: SettingValue; after: SettingValue | null; ok: boolean; note?: string }

/** Things only a person at the aircraft can vouch for. Never a tool argument. */
export type Condition = 'propsRemoved' | 'directUsb' | 'batteryConnected' | 'batteryDisconnected' | 'areaClear' | 'level' | 'still' | 'firmwareMatchesBoard';
export const CONDITION_LABEL: Record<Condition, string> = {
  propsRemoved: 'Props removed', directUsb: 'Direct USB', batteryConnected: 'Battery connected', batteryDisconnected: 'Battery disconnected',
  areaClear: 'Area clear', level: 'Sitting level', still: 'Not moving', firmwareMatchesBoard: 'Right firmware file',
};

/** 0 observe, 2 configure (approval), 3 energise (person starts it). */
export type Level = 0 | 2 | 3;
export interface TestArg { name: string; type: 'number' | 'enum' | 'text' | 'file'; min?: number; max?: number; default?: number | string; options?: string[]; unit?: string; required?: boolean }
export interface TestSpec {
  id: string; name: string; part: PartId; level: Level;
  /** What a passing result proves, in one sentence. */
  proves: string;
  needs: Condition[];
  seconds: number;
  args?: TestArg[];
  /** True when the procedure needs a person to act partway through (rotate the aircraft, pick a file). */
  interactive?: boolean;
}
export interface TestResult { id: string; ok: boolean | null; summary: string; data?: unknown; at: number }

export interface EscInfo {
  index: number;
  firmware: 'BLHeli_S' | 'Bluejay' | 'AM32' | 'Unknown';
  version?: string; layout?: string; mcu?: string; signature?: string; interfaceMode?: number;
  /** True when Armable knows this layout well enough to change its settings. */
  writable: boolean;
  error?: string;
  at: number;
}

export interface LogEntry { id: number; size: number; time?: number }

export type DriverEvent =
  | { type: 'state' }
  | { type: 'settings'; ids?: string[] }
  | { type: 'progress'; label: string; done?: number; total?: number }
  | { type: 'reconnect-needed'; reason: string }
  | { type: 'closed'; reason: string };

/** Proof that a person at the bench approved one specific operation. Only the runtime can mint one. */
export interface Grant { readonly conditions: readonly Condition[]; readonly operation: string }

/** file resolves to bytes; step to true/false; serial to a ByteTransport; dfu to a DfuPort. Each needs a click, so only the UI can answer. */
export interface PromptRequest { kind: 'file' | 'step' | 'serial' | 'dfu'; label: string; accept?: string }
export interface RunContext {
  grant?: Grant;
  args?: Record<string, unknown>;
  progress?: (label: string, done?: number, total?: number) => void;
  /** Ask the person for something mid-procedure (a file, a physical step). Resolves when they respond. */
  prompt?: (request: PromptRequest) => Promise<unknown>;
  signal?: AbortSignal;
}

export interface Driver {
  readonly identity: Identity;
  readonly transportLabel: string;
  state(): LiveState;
  airframe(): Airframe;
  /** Every setting known so far. Call loadSettings to fill it. */
  settings(): Setting[];
  settingsLoaded(): 'none' | 'loading' | 'partial' | 'complete';
  loadSettings(progress?: RunContext['progress']): Promise<void>;
  /** Fresh read of specific settings from the device. */
  refresh(ids: string[]): Promise<Setting[]>;
  /** Write, then read back. Needs a grant. */
  write(changes: Change[], ctx: RunContext): Promise<ChangeResult[]>;
  tests(): TestSpec[];
  run(id: string, ctx: RunContext): Promise<TestResult>;
  /** Restart into the mode that accepts new firmware. The connection drops. */
  enterBootloader?(): Promise<void>;
  /** Stop anything that is moving. Always allowed. */
  stop(): Promise<void>;
  escs(): EscInfo[];
  logs(): LogEntry[];
  lastLogAnalysis(): { id: number; analysis: FlightLogAnalysis } | undefined;
  on(listener: (event: DriverEvent) => void): () => void;
  close(): Promise<void>;
}

/** Shared event plumbing and the single-operation lock every driver needs. */
export abstract class DriverBase {
  private listeners = new Set<(event: DriverEvent) => void>();
  private operation?: string;
  on(listener: (event: DriverEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  protected emit(event: DriverEvent) { for (const l of [...this.listeners]) l(event); }
  get busyWith() { return this.operation; }
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  /**
   * Run one device operation at a time. A second caller waits its turn instead of interleaving bytes on the wire;
   * after two minutes of waiting it gets a clear "busy" answer.
   */
  protected async exclusive<T>(label: string, fn: () => Promise<T>, waitMs = 120_000): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(r => { release = r; });
    this.waiting++;
    try {
      const timedOut = await Promise.race([previous.then(() => false, () => false), new Promise<boolean>(r => setTimeout(() => r(true), waitMs))]);
      if (timedOut) throw new (await import('./bytes')).DeviceError('busy', `Busy: ${this.operation ?? 'another task'}. Try again when it finishes.`);
      this.operation = label;
      try { return await fn(); } finally { this.operation = undefined; }
    } finally { this.waiting--; release(); }
  }
}
