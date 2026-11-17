import { DeviceError } from '../bytes';
import type { Change, ChangeResult, RunContext, TestResult } from '../types';
import { encodeEscField, escSettings, flashEsc, parseEscHex, patchEscSettings, readEsc, type EscRead, type FourWay } from './fourway';
import { ARM_MODE, parseAm32Hex } from './am32';

/** What a driver does once passthrough is open. The same code serves ArduPilot and Betaflight. */
export type EscSession = <T>(write: boolean, ctx: RunContext, fn: (link: FourWay, count: number) => Promise<T>) => Promise<T>;
const merge = (reads: EscRead[], next: EscRead) => [...reads.filter(r => r.info.index !== next.info.index), next].sort((a, b) => a.info.index - b.info.index);

export async function readAllEscs(session: EscSession, ctx: RunContext, now: () => number): Promise<{ reads: EscRead[]; result: TestResult }> {
  const reads = await session(false, ctx, async (link, count) => {
    const out: EscRead[] = [];
    for (let i = 0; i < count; i++) {
      ctx.progress?.('Reading ESCs', i, count);
      try { out.push(await readEsc(link, i, now)); }
      catch (error) { out.push({ info: { index: i + 1, at: now(), firmware: 'Unknown', writable: false, error: error instanceof Error ? error.message : 'Read failed.' } }); }
      await link.reset(i).catch(() => {});
    }
    return out;
  });
  const failed = reads.filter(r => r.info.error);
  return { reads, result: { id: 'esc.read', at: now(), ok: failed.length === 0, summary: `${reads.length - failed.length} of ${reads.length} ESCs read.`,
    data: reads.map(r => ({ ...r.info, settings: r.block ? Object.fromEntries(escSettings(r.info, r.block).map(s => [s.name, s.value])) : undefined })) } };
}

export async function writeEscChanges(session: EscSession, ctx: RunContext, now: () => number, changes: Change[], known: EscRead[]): Promise<{ reads: EscRead[]; results: ChangeResult[] }> {
  const byEsc = new Map<number, Change[]>();
  for (const c of changes) { const index = Number(c.id.split('.')[1]); byEsc.set(index, [...(byEsc.get(index) ?? []), c]); }
  const results: ChangeResult[] = [];
  let reads = known;
  try {
    await session(true, ctx, async (link, count) => {
      for (const [index, list] of byEsc) {
        const fail = (note: string) => list.forEach(c => results.push({ id: c.id, before: null, requested: c.value, after: null, ok: false, note }));
        if (!(index >= 1 && index <= count)) { fail(`There is no ESC ${index}.`); continue; }
        try {
          ctx.progress?.(`Writing ESC ${index}`);
          const before = await readEsc(link, index - 1, now);
          if (!before.info.writable || !before.block) { fail(before.info.error ?? 'Lucidity cannot change settings on this ESC firmware yet.'); await link.reset(index - 1).catch(() => {}); continue; }
          const current = Object.fromEntries(escSettings(before.info, before.block).map(s => [s.id, s.value]));
          const stale = list.find(c => c.expected !== undefined && String(current[c.id]) !== String(c.expected).toLowerCase());
          if (stale) { fail(`${stale.id} is now ${current[stale.id]}, not ${stale.expected}. Nothing was written.`); await link.reset(index - 1).catch(() => {}); continue; }
          await patchEscSettings(link, list.map(c => encodeEscField(c.id.split('.').slice(2).join('.'), c.value, before.info.firmware)), before);
          const after = await readEsc(link, index - 1, now);
          const fresh = Object.fromEntries(escSettings(after.info, after.block!).map(s => [s.id, s.value]));
          reads = merge(reads, after);
          for (const c of list) results.push({ id: c.id, before: current[c.id] ?? null, requested: c.value, after: fresh[c.id] ?? null, ok: String(fresh[c.id]) === String(c.value).toLowerCase() });
          await link.reset(index - 1).catch(() => {});
        } catch (error) {
          fail(error instanceof Error ? error.message : 'ESC write failed.');
          if (!(error instanceof DeviceError) || !['invalid', 'unsupported'].includes(error.code)) throw error;
        }
      }
    });
  } catch (error) {
    const note = error instanceof Error ? error.message : 'ESC session failed.';
    for (const c of changes) if (!results.some(r => r.id === c.id)) results.push({ id: c.id, before: null, requested: c.value, after: null, ok: false, note });
  }
  return { reads, results };
}

export async function flashEscs(session: EscSession, ctx: RunContext, now: () => number, only: number | undefined, known: EscRead[]): Promise<{ reads: EscRead[]; result: TestResult }> {
  const file = await ctx.prompt?.({ kind: 'file', label: 'Choose the ESC firmware (.hex)', accept: '.hex' });
  if (!(file instanceof Uint8Array)) throw new DeviceError('invalid', 'No firmware file was chosen.');
  const text = new TextDecoder().decode(file);
  // The same file type serves two kinds of ESC; parse it for the kind found, so a mismatch is caught per ESC.
  const firmwareFor = (read: EscRead) => read.info.interfaceMode === ARM_MODE ? parseAm32Hex(text) : parseEscHex(text);
  const done: { esc: number; ok: boolean; note: string }[] = [];
  let reads = known;
  await session(true, ctx, async (link, count) => {
    for (let i = 0; i < count; i++) {
      if (only !== undefined && only !== i + 1) continue;
      try {
        const current = await readEsc(link, i, now);
        await flashEsc(link, current, firmwareFor(current), (label, a, b) => ctx.progress?.(`ESC ${i + 1}: ${label}`, a, b));
        const after = await readEsc(link, i, now);
        reads = merge(reads, after);
        done.push({ esc: i + 1, ok: true, note: `${after.info.firmware} ${after.info.version}` });
        await link.reset(i).catch(() => {});
      } catch (error) {
        done.push({ esc: i + 1, ok: false, note: error instanceof Error ? error.message : 'Flash failed.' });
        if (!(error instanceof DeviceError) || !['mismatch', 'unsupported', 'invalid'].includes(error.code)) throw error;
      }
    }
  });
  const failed = done.filter(d => !d.ok);
  return { reads, result: { id: 'esc.flash', at: now(), ok: failed.length === 0 && done.length > 0,
    summary: failed.length ? `${failed.length} ESC${failed.length > 1 ? 's' : ''} not flashed: ${failed[0].note}` : `${done.length} ESC${done.length > 1 ? 's' : ''} flashed and verified.`, data: done } };
}
