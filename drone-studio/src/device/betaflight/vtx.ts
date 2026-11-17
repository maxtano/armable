import { DeviceError } from '../bytes';

/**
 * Betaflight video transmitter tables (4.1 and later). The table tells the flight controller which frequencies and
 * power levels the fitted transmitter offers; band, channel and power settings are indexes into it.
 */
export interface VtxBand { number: number; name: string; letter: string; factory: boolean; frequencies: number[] }
export interface VtxTable { bands: VtxBand[]; channels: number; powers: { value: number; label: string }[] }

const STANDARD_BANDS: VtxBand[] = [
  { number: 1, name: 'BOSCAM_A', letter: 'A', factory: true, frequencies: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725] },
  { number: 2, name: 'BOSCAM_B', letter: 'B', factory: true, frequencies: [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866] },
  { number: 3, name: 'BOSCAM_E', letter: 'E', factory: true, frequencies: [5705, 5685, 5665, 0, 5885, 5905, 0, 0] },
  { number: 4, name: 'FATSHARK', letter: 'F', factory: true, frequencies: [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880] },
  { number: 5, name: 'RACEBAND', letter: 'R', factory: true, frequencies: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917] },
];
/** Common tables, from Betaflight's published VTX table guidance. Check your transmitter's manual for its power values. */
export const VTX_PRESETS: Record<string, VtxTable> = {
  'SmartAudio 2.0': { bands: STANDARD_BANDS, channels: 8, powers: [{ value: 0, label: '25' }, { value: 1, label: '200' }, { value: 2, label: '500' }, { value: 3, label: '800' }] },
  'SmartAudio 2.1': { bands: STANDARD_BANDS, channels: 8, powers: [{ value: 14, label: '25' }, { value: 20, label: '100' }, { value: 26, label: '400' }, { value: 29, label: '800' }] },
  'Tramp': { bands: STANDARD_BANDS, channels: 8, powers: [{ value: 25, label: '25' }, { value: 100, label: '100' }, { value: 200, label: '200' }, { value: 400, label: '400' }, { value: 600, label: '600' }] },
  'MSP video system': { bands: STANDARD_BANDS, channels: 8, powers: [{ value: 1, label: '25' }, { value: 2, label: '200' }, { value: 3, label: '500' }] },
};

export function parseVtxTable(text: string): VtxTable | undefined {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('vtxtable '));
  if (!lines.length) return undefined;
  const t: VtxTable = { bands: [], channels: 0, powers: [] };
  let values: number[] = [], labels: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\s+/).slice(1);
    if (parts[0] === 'channels') t.channels = Number(parts[1]);
    else if (parts[0] === 'band') t.bands.push({ number: Number(parts[1]), name: parts[2], letter: parts[3], factory: parts[4] === 'FACTORY', frequencies: parts.slice(5).map(Number) });
    else if (parts[0] === 'powervalues') values = parts.slice(1).map(Number);
    else if (parts[0] === 'powerlabels') labels = parts.slice(1);
  }
  t.powers = values.map((value, i) => ({ value, label: labels[i] ?? String(value) }));
  return t.bands.length || t.powers.length ? t : undefined;
}
export function validateVtxTable(t: VtxTable): VtxTable {
  const bad = (m: string): never => { throw new DeviceError('invalid', `That video table is not valid: ${m}`); };
  if (!(t.bands.length >= 1 && t.bands.length <= 8)) bad('1 to 8 bands.');
  if (!(Number.isInteger(t.channels) && t.channels >= 1 && t.channels <= 8)) bad('1 to 8 channels.');
  if (!(t.powers.length >= 1 && t.powers.length <= 8)) bad('1 to 8 power levels.');
  t.bands.forEach((b, i) => {
    if (b.number !== i + 1) bad('bands must be numbered 1, 2, 3 in order.');
    if (!/^[A-Z0-9_]{1,8}$/.test(b.name) || !/^[A-Z0-9]$/.test(b.letter)) bad('band names are up to 8 capitals, letters are one capital.');
    if (b.frequencies.length !== t.channels || b.frequencies.some(f => !Number.isInteger(f) || (f !== 0 && (f < 1000 || f > 9999)))) bad(`band ${b.name} needs ${t.channels} frequencies in MHz (0 for none).`);
  });
  t.powers.forEach(p => { if (!Number.isInteger(p.value) || p.value < 0 || p.value > 9999 || !/^[A-Za-z0-9]{1,3}$/.test(p.label)) bad('power values are whole numbers and labels up to 3 characters.'); });
  return t;
}
/** The console commands that set a table. `save` is sent separately. */
export function vtxTableCommands(t: VtxTable): string[] {
  validateVtxTable(t);
  return [
    `vtxtable bands ${t.bands.length}`, `vtxtable channels ${t.channels}`,
    ...t.bands.map(b => `vtxtable band ${b.number} ${b.name} ${b.letter} ${b.factory ? 'FACTORY' : 'CUSTOM'} ${b.frequencies.join(' ')}`),
    `vtxtable powerlevels ${t.powers.length}`, `vtxtable powervalues ${t.powers.map(p => p.value).join(' ')}`, `vtxtable powerlabels ${t.powers.map(p => p.label).join(' ')}`,
  ];
}
export function presetName(t: VtxTable | undefined): string {
  if (!t) return 'none';
  const same = (a: VtxTable, b: VtxTable) => JSON.stringify(a) === JSON.stringify(b);
  return Object.entries(VTX_PRESETS).find(([, p]) => same(p, t))?.[0] ?? 'custom';
}
export function frequency(t: VtxTable | undefined, band: number, channel: number): number | undefined {
  const f = t?.bands[band - 1]?.frequencies[channel - 1];
  return f ? f : undefined;
}
