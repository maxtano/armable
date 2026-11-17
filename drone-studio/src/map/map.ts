import type { FlightLogAnalysis } from '../aircraft/dataflash-analysis';
import type { AircraftSnapshot } from '../device/runtime';
import type { PartId, Setting, Stack, TestSpec } from '../device/types';
import { PLAYBOOKS, REFERENCES, SYNONYMS, type Playbook, type Reference } from './library';

/**
 * The map: everything the connected aircraft offers, as searchable entries of five kinds.
 * The bench tab mirrors its state to the cloud; the map is computed from that mirror, so the
 * assistant, the diagram and the checks all describe the same aircraft.
 */
export interface Mirror {
  /** When the bench tab last sent anything. */
  at: number;
  snapshot: AircraftSnapshot;
  settings: Setting[];
  log?: { id: number; analysis: FlightLogAnalysis };
}
export type Kind = 'reading' | 'test' | 'setting' | 'reference' | 'playbook';
export interface NextCall { tool: string; arguments: Record<string, unknown> }
export interface Hit {
  kind: Kind | 'unavailable';
  id: string;
  title: string;
  part?: PartId | string;
  value?: unknown;
  unit?: string;
  allowed?: string;
  level?: number;
  summary?: string;
  url?: string;
  steps?: Playbook['steps'];
  caution?: string;
  /** The exact call to make next. */
  use?: NextCall;
}

interface ReadingDef { id: string; title: string; unit?: string; part: PartId; words: string[]; get(m: Mirror): unknown }
const r1 = (v: number | undefined, digits = 1) => v === undefined ? undefined : Math.round(v * 10 ** digits) / 10 ** digits;
const summary = (s: { mean: number; p95: number; peak: number } | null | undefined) => s ? { mean: r1(s.mean, 2), p95: r1(s.p95, 2), peak: r1(s.peak, 2) } : null;

export const READINGS: ReadingDef[] = [
  { id: 'link.status', title: 'Connection', part: 'link', words: ['link', 'connection', 'connected', 'usb', 'online'], get: m => ({ status: m.snapshot.status, fresh: m.snapshot.state?.linkOk ?? false, port: m.snapshot.label, demo: m.snapshot.demo ?? false }) },
  { id: 'fc.identity', title: 'Firmware and board', part: 'fc', words: ['firmware', 'version', 'board', 'target', 'stack', 'identity', 'name'], get: m => m.snapshot.identity },
  { id: 'fc.armed', title: 'Armed', part: 'fc', words: ['armed', 'arm', 'disarmed'], get: m => m.snapshot.state?.armed },
  { id: 'fc.mode', title: 'Flight mode', part: 'fc', words: ['mode', 'flight'], get: m => m.snapshot.state?.mode },
  { id: 'fc.cpu', title: 'Processor load', unit: '%', part: 'fc', words: ['cpu', 'load', 'processor'], get: m => m.snapshot.state?.cpuLoad },
  { id: 'attitude.roll', title: 'Roll', unit: '°', part: 'fc', words: ['roll', 'attitude', 'tilt', 'level', 'angle'], get: m => m.snapshot.state?.attitude?.roll },
  { id: 'attitude.pitch', title: 'Pitch', unit: '°', part: 'fc', words: ['pitch', 'attitude', 'tilt', 'level', 'angle'], get: m => m.snapshot.state?.attitude?.pitch },
  { id: 'attitude.yaw', title: 'Heading', unit: '°', part: 'fc', words: ['yaw', 'heading', 'attitude', 'compass'], get: m => m.snapshot.state?.attitude?.yaw },
  { id: 'battery.voltage', title: 'Battery voltage', unit: 'V', part: 'battery', words: ['battery', 'voltage', 'volts', 'power'], get: m => m.snapshot.state?.battery?.voltage },
  { id: 'battery.current', title: 'Battery current', unit: 'A', part: 'battery', words: ['battery', 'current', 'amps', 'draw'], get: m => m.snapshot.state?.battery?.current },
  { id: 'battery.remaining', title: 'Battery remaining', unit: '%', part: 'battery', words: ['battery', 'remaining', 'charge', 'percent'], get: m => m.snapshot.state?.battery?.remaining },
  { id: 'battery.cells', title: 'Cell count', part: 'battery', words: ['battery', 'cells', 'cell'], get: m => m.snapshot.state?.battery?.cells },
  { id: 'gps.fix', title: 'GPS fix', part: 'gps', words: ['gps', 'fix', 'position', 'lock'], get: m => m.snapshot.state?.gps && { fix: m.snapshot.state.gps.fix >= 3 ? '3D' : m.snapshot.state.gps.fix === 2 ? '2D' : 'none', hdop: m.snapshot.state.gps.hdop } },
  { id: 'gps.sats', title: 'Satellites', part: 'gps', words: ['gps', 'satellites', 'sats'], get: m => m.snapshot.state?.gps?.sats },
  { id: 'rc.channels', title: 'Receiver channels', unit: 'µs', part: 'receiver', words: ['rc', 'receiver', 'channels', 'sticks', 'switches', 'radio'], get: m => m.snapshot.state?.rc?.channels },
  { id: 'rc.rssi', title: 'Signal strength', unit: '%', part: 'receiver', words: ['rssi', 'signal', 'strength', 'receiver', 'radio'], get: m => m.snapshot.state?.rc?.rssi },
  { id: 'motor.outputs', title: 'Motor outputs', unit: 'µs', part: 'motors', words: ['motor', 'motors', 'output', 'outputs', 'throttle'], get: m => m.snapshot.state?.motors?.outputs },
  { id: 'esc.telemetry', title: 'ESC telemetry', part: 'motors', words: ['esc', 'rpm', 'temperature', 'telemetry'], get: m => m.snapshot.state?.esc },
  { id: 'escs.summary', title: 'ESC firmware', part: 'motors', words: ['esc', 'escs', 'firmware', 'blheli', 'bluejay', 'am32'], get: m => m.snapshot.escs.length ? m.snapshot.escs.map(e => ({ esc: e.index, firmware: e.firmware, version: e.version, layout: e.layout, changeable: e.writable, error: e.error })) : undefined },
  { id: 'sensors.health', title: 'Sensor health', part: 'fc', words: ['sensors', 'sensor', 'health', 'gyro', 'accel', 'baro', 'compass'], get: m => m.snapshot.state?.sensors },
  { id: 'vibration.live', title: 'Vibration now', unit: 'm/s²', part: 'fc', words: ['vibration', 'shake', 'clipping'], get: m => m.snapshot.state?.vibration },
  { id: 'arming.blocks', title: 'Why it will not arm', part: 'safety', words: ['arm', 'arming', 'prearm', 'blocks', 'wont', 'reasons'], get: m => m.snapshot.state?.armingBlocks },
  { id: 'messages.recent', title: 'Messages from the aircraft', part: 'fc', words: ['messages', 'status', 'text', 'errors', 'warnings'], get: m => m.snapshot.state?.messages.slice(-8).map(x => ({ text: x.text, severity: x.severity })) },
  { id: 'vtx.frequency', title: 'Video frequency', unit: 'MHz', part: 'vtx', words: ['video', 'vtx', 'frequency', 'channel', 'band', 'mhz'],
    get: m => { const v = (id: string) => m.settings.find(s => s.id === id); const ch = v('bf.vtx_channel'); const label = ch?.options?.find(o => String(o.value) === String(ch.value))?.label; const mhz = label?.match(/(\d{4}) MHz/)?.[1]; return mhz ? Number(mhz) : Number(v('bf.vtx_freq')?.value) || undefined; } },
  { id: 'airframe.layout', title: 'Motor layout', part: 'motors', words: ['airframe', 'frame', 'layout', 'motor', 'order', 'direction', 'spin', 'position'],
    get: m => m.snapshot.airframe && { layout: m.snapshot.airframe.label, known: m.snapshot.airframe.known, motors: m.snapshot.airframe.motors.map(x => ({ motor: x.number, position: `${x.y > 0.2 ? 'front' : x.y < -0.2 ? 'rear' : 'middle'}${x.x > 0.2 ? ' right' : x.x < -0.2 ? ' left' : ''}`, expectedSpin: x.spin === 'cw' ? 'clockwise' : x.spin === 'ccw' ? 'counter-clockwise' : 'unknown' })) } },
  { id: 'logs.list', title: 'Flight logs on the aircraft', part: 'logging', words: ['logs', 'log', 'flights', 'recordings'], get: m => m.snapshot.logs.length ? m.snapshot.logs : undefined },
  { id: 'log.latest.summary', title: 'Last analysed flight', part: 'logging', words: ['log', 'flight', 'summary', 'last', 'analysis'],
    get: m => m.log && { log: m.log.id, seconds: r1(m.log.analysis.durationSeconds ?? undefined), throttle: m.log.analysis.throttle && { min: r1(m.log.analysis.throttle.outputMin, 2), max: r1(m.log.analysis.throttle.outputMax, 2) }, caveats: m.log.analysis.caveats.slice(0, 3) } },
  { id: 'log.latest.vibration', title: 'Vibration in the last analysed flight', unit: 'm/s²', part: 'logging', words: ['log', 'vibration', 'shake', 'clipping', 'flight'],
    get: m => m.log?.analysis.vibration && { sensors: m.log.analysis.vibration.sensors.map(s => ({ imu: s.imu, x: summary(s.vibeX), y: summary(s.vibeY), z: summary(s.vibeZ), clippingEvents: s.clippingEvents })), throttleCorrelation: r1(m.log.analysis.throttle?.vibrationCorrelation ?? undefined, 2), guide: 'Below 15 is good, 15 to 30 is marginal, above 30 is a problem. Clipping above zero is a problem.' } },
  { id: 'log.latest.tracking', title: 'Control tracking in the last analysed flight', part: 'logging', words: ['log', 'tracking', 'error', 'rate', 'attitude', 'tune', 'oscillation'],
    get: m => m.log && { rateErrorDegPerS: m.log.analysis.rate && { roll: summary(m.log.analysis.rate.rollErrorDegS), pitch: summary(m.log.analysis.rate.pitchErrorDegS), yaw: summary(m.log.analysis.rate.yawErrorDegS) }, attitudeErrorDeg: m.log.analysis.attitude && { roll: summary(m.log.analysis.attitude.rollErrorDeg), pitch: summary(m.log.analysis.attitude.pitchErrorDeg) } } },
  { id: 'log.latest.battery', title: 'Battery in the last analysed flight', part: 'logging', words: ['log', 'battery', 'sag', 'voltage', 'current', 'flight'], get: m => m.log?.analysis.battery },
];

/** Things people ask for that this aircraft cannot do yet, with the reason. Shown instead of silence. */
const UNAVAILABLE: { words: string[]; stacks: Stack[] | 'all'; title: string; reason: string }[] = [
  { words: ['sd', 'card', 'sdcard'], stacks: ['betaflight', 'inav'], title: 'Logs on an SD card', reason: 'Logs on an SD card cannot be read over USB. Copy the .bbl file off the card and open it in Flights.' },
  { words: ['esc', 'escs', 'passthrough', 'direction'], stacks: ['px4'], title: 'ESC settings', reason: 'ESC passthrough is not available on PX4.' },
  { words: ['arm', 'takeoff', 'launch', 'fly', 'mission', 'land'], stacks: 'all', title: 'Arming and flight', reason: 'Lucidity never arms, launches or flies an aircraft for an assistant. The pilot does that.' },
  { words: ['blheli32', 'blheli_32'], stacks: 'all', title: 'BLHeli_32 ESCs', reason: 'BLHeli_32 is closed firmware and is not supported. BLHeli_S, Bluejay and AM32 are.' },
  { words: ['elrs', 'expresslrs', 'esp', 'esp32', 'receiver', 'flash'], stacks: 'all', title: 'Receiver and radio firmware', reason: 'Flashing receiver or radio firmware is not built yet in the hosted app.' },
];

const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function expand(query: string): string[][] { return tokens(query).map(t => [t, ...(SYNONYMS[t] ?? []).flatMap(tokens)]); }

interface Doc { hit: () => Hit; id: string[]; title: string[]; words: string[]; text: string; boost: number }
const docOf = (id: string, title: string, words: string[], text: string, boost: number, hit: () => Hit): Doc => ({ hit, id: tokens(id), title: tokens(title), words: words.map(w => w.toLowerCase()), text: text.toLowerCase(), boost });

function allowedText(s: Setting): string | undefined {
  if (s.options) return s.options.length <= 12 ? s.options.map(o => o.label).join(', ') : `${s.options.length} options`;
  if (s.min !== undefined && s.max !== undefined) return `${s.min} to ${s.max}${s.unit ? ` ${s.unit}` : ''}`;
  return undefined;
}
export function settingHit(s: Setting): Hit {
  return { kind: 'setting', id: s.id, title: s.title ?? s.name, part: s.part, value: s.value, unit: s.unit, allowed: allowedText(s), level: 2, summary: s.description?.slice(0, 160),
    use: s.readOnly ? { tool: 'read', arguments: { ids: [s.id] } } : { tool: 'propose_change', arguments: { changes: [{ id: s.id, value: '<new value>' }] } } };
}
export function testHit(t: TestSpec): Hit {
  const args = t.args?.filter(a => a.type !== 'file');
  return { kind: 'test', id: t.id, title: t.name, part: t.part, level: t.level, summary: `${t.proves}${t.level === 2 ? ' Needs approval in Lucidity.' : t.level === 3 ? ' The person starts it in Lucidity.' : ''}`,
    allowed: args?.length ? args.map(a => `${a.name}${a.required ? '' : '?'}: ${a.min}–${a.max}${a.unit ?? ''}`).join(', ') : undefined,
    use: { tool: 'run_test', arguments: { id: t.id, ...(args?.some(a => a.required) ? { args: Object.fromEntries(args.filter(a => a.required).map(a => [a.name, a.min])) } : {}) } } };
}
const referenceHit = (r: Reference): Hit => ({ kind: 'reference', id: r.id, title: r.title, part: r.part, url: r.url, summary: r.note ?? (r.kind === 'video' ? 'Video' : r.kind === 'tool' ? 'Tool' : 'Guide'), use: { tool: 'show', arguments: { target: r.id } } });
const playbookHit = (p: Playbook): Hit => ({ kind: 'playbook', id: p.id, title: p.symptom, steps: p.steps, caution: p.caution });

function docs(mirror: Mirror | undefined): Doc[] {
  const stack = mirror?.snapshot.identity?.stack;
  const forStack = <T extends { stacks?: Stack[] }>(list: T[]) => list.filter(x => !x.stacks || !stack || x.stacks.includes(stack));
  const out: Doc[] = [];
  for (const p of forStack(PLAYBOOKS)) out.push(docOf(p.id, p.symptom, p.words, '', 1.5, () => playbookHit(p)));
  for (const r of forStack(REFERENCES)) out.push(docOf(r.id, r.title, r.words, '', 0, () => referenceHit(r)));
  if (!mirror || mirror.snapshot.status !== 'connected') return out;
  for (const r of READINGS) out.push(docOf(r.id, r.title, r.words, '', 0.6, () => ({ kind: 'reading', id: r.id, title: r.title, part: r.part, unit: r.unit, value: compact(r.get(mirror)), use: { tool: 'read', arguments: { ids: [r.id] } } })));
  for (const t of mirror.snapshot.tests) out.push(docOf(t.id, t.name, [t.part], t.proves, 0.8, () => testHit(t)));
  for (const s of mirror.settings) out.push(docOf(s.id, s.title ?? '', [s.part, s.group], s.description ?? '', s.title ? 0.4 : 0, () => settingHit(s)));
  return out;
}
/** Keep a value small enough to sit in a search result. */
function compact(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(value);
  return text.length <= 160 ? value : `${text.slice(0, 150)}…`;
}

export interface FindOptions { kinds?: Kind[]; part?: string; limit?: number }
export function find(mirror: Mirror | undefined, query: string, options: FindOptions = {}): { hits: Hit[]; total: number; note?: string } {
  const groups = expand(query);
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 25);
  if (!groups.length) return { hits: [], total: 0, note: 'Give a word or two, such as "motor direction" or "wont arm".' };
  const flat = query.toLowerCase().trim();
  const scored: { doc: Doc; score: number }[] = [];
  for (const doc of docs(mirror)) {
    let score = 0, matched = 0;
    for (const group of groups) {
      let best = 0;
      group.forEach((t, i) => {
        const weight = i === 0 ? 1 : 0.6;
        let s = 0;
        if (doc.id.includes(t)) s = 3; else if (doc.title.includes(t)) s = 3; else if (doc.words.includes(t)) s = 2.2;
        else if (t.length >= 3 && (doc.id.some(x => x.startsWith(t) || (t.length > 3 && x.includes(t))) || doc.title.some(x => x.startsWith(t)))) s = 1.6;
        else if (t.length > 3 && doc.text.includes(t)) s = 0.8;
        best = Math.max(best, s * weight);
      });
      if (best > 0) matched++;
      score += best;
    }
    if (!matched) continue;
    if (doc.id.join('.') === tokens(flat).join('.')) score += 20;
    score = score * (matched / groups.length) + doc.boost * (matched / groups.length);
    scored.push({ doc, score });
  }
  let hits = scored.sort((a, b) => b.score - a.score || a.doc.id.length - b.doc.id.length).map(s => s.doc.hit());
  if (options.kinds?.length) hits = hits.filter(h => options.kinds!.includes(h.kind as Kind));
  if (options.part) hits = hits.filter(h => h.part === options.part);
  const stack = mirror?.snapshot.identity?.stack;
  const words = new Set(groups.map(g => g[0]));
  const blocked = UNAVAILABLE.filter(u => (u.stacks === 'all' || (stack && u.stacks.includes(stack))) && u.words.some(w => words.has(w)))
    .filter(u => u.stacks !== 'all' || u.words.filter(w => words.has(w)).length >= 1)
    .map((u): Hit => ({ kind: 'unavailable', id: `unavailable.${u.title.toLowerCase().replace(/\W+/g, '-')}`, title: u.title, summary: u.reason }));
  const total = hits.length;
  hits = [...hits.slice(0, limit - Math.min(blocked.length, 1)), ...blocked.slice(0, 1)];
  const note = !mirror || mirror.snapshot.status !== 'connected' ? 'No aircraft is connected, so only playbooks and references are listed. Readings, tests and settings appear once the person opens Lucidity and connects the drone.'
    : mirror.snapshot.settingsLoaded !== 'complete' && !hits.some(h => h.kind === 'setting') ? 'Settings have not been read from the aircraft yet. Call read with ids ["settings.load"] to read them, then search again.' : undefined;
  return { hits, total, note };
}

export interface ReadResult { id: string; title?: string; value: unknown; unit?: string; allowed?: string; ageMs?: number; error?: string; didYouMean?: string[] }
export function readEntry(mirror: Mirror, id: string, now: number): ReadResult {
  const reading = READINGS.find(r => r.id === id);
  if (reading) {
    const value = reading.get(mirror);
    const live = !id.startsWith('log.') && !id.startsWith('escs.') && id !== 'logs.list';
    return { id, title: reading.title, value: value ?? null, unit: reading.unit, ageMs: live && mirror.snapshot.state ? Math.max(0, now - mirror.snapshot.state.at) : undefined,
      ...(value === undefined || value === null ? { error: id.startsWith('log.') ? 'No flight log has been analysed yet. Run the test logs.analyze first.' : id.startsWith('escs.') ? 'The ESCs have not been read yet. Run the test esc.read first.' : 'The aircraft has not reported this.' } : {}) };
  }
  const setting = mirror.settings.find(s => s.id === id);
  if (setting) return { id, title: setting.title ?? setting.name, value: setting.value, unit: setting.unit, allowed: allowedText(setting), ageMs: Math.max(0, now - setting.at) };
  const near = find(mirror, id.replace(/[._]/g, ' '), { limit: 4 }).hits.filter(h => h.kind === 'reading' || h.kind === 'setting').map(h => h.id);
  return { id, value: null, error: mirror.snapshot.settingsLoaded === 'complete' || !/^(param|bf|esc)\./.test(id) ? 'There is nothing with this id on this aircraft.' : 'Not found. Settings have not been fully read yet; read "settings.load" first.', didYouMean: near.length ? near : undefined };
}

/** One-screen summary of what the map holds, for get_workspace. */
export function mapSummary(mirror: Mirror | undefined) {
  if (!mirror || mirror.snapshot.status !== 'connected') return { readings: 0, tests: 0, settings: 0, playbooks: PLAYBOOKS.length, references: REFERENCES.length };
  const stack = mirror.snapshot.identity?.stack;
  return {
    readings: READINGS.length, tests: mirror.snapshot.tests.length, settings: mirror.settings.length,
    playbooks: PLAYBOOKS.filter(p => !p.stacks || !stack || p.stacks.includes(stack)).length,
    references: REFERENCES.filter(r => !r.stacks || !stack || r.stacks.includes(stack)).length,
  };
}
