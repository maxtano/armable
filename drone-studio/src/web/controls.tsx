import { useEffect, useState } from 'react';
import { Check, Minus, Plus, X } from 'lucide-react';
import { CONDITION_LABEL, type Condition, type Setting } from '../device/types';
import { applyChanges } from './controller';
import { format, optionLabel } from './parts';
import { clearMark, useStore } from './store';

/** Tick boxes for the things only a person at the aircraft can vouch for. */
export function Conditions({ needs, value, onChange }: { needs: string[]; value: Condition[]; onChange(next: Condition[]): void }) {
  if (!needs.length) return null;
  return (
    <div className="lu-conditions" role="group" aria-label="Confirm at the aircraft">
      {(needs as Condition[]).map(n => (
        <label key={n} className={value.includes(n) ? 'is-on' : ''}>
          <input type="checkbox" checked={value.includes(n)} onChange={e => onChange(e.target.checked ? [...value, n] : value.filter(x => x !== n))} />
          <span className="lu-tick"><Check size={12} strokeWidth={3} /></span>{CONDITION_LABEL[n] ?? n}
        </label>
      ))}
    </div>
  );
}

/**
 * One setting as a simple control. Changing it does not write anything: it shows the new value beside the
 * old one with a tick to apply. Applying writes to the aircraft and reads back.
 */
export function SettingControl({ setting, compact }: { setting: Setting; compact?: boolean }) {
  const [draft, setDraft] = useState<string | number>(setting.value);
  const [confirmed, setConfirmed] = useState<Condition[]>([]);
  const busy = useStore(s => !!s.busy), changed = useStore(s => s.marks[setting.id]);
  useEffect(() => { setDraft(setting.value); }, [setting.value]);
  const dirty = String(draft) !== String(setting.value);
  const needs: Condition[] = setting.id.startsWith('esc.') ? ['propsRemoved', 'directUsb'] : [];
  const ready = needs.every(n => confirmed.includes(n));
  const step = setting.step ?? 1;
  const clamp = (n: number) => Math.min(setting.max ?? Infinity, Math.max(setting.min ?? -Infinity, Number(n.toFixed(6))));
  const apply = async () => { await applyChanges([{ id: setting.id, value: draft, expected: setting.value }], confirmed); setConfirmed([]); };
  const label = setting.title ?? setting.name;
  return (
    <div className={`lu-setting${dirty ? ' is-dirty' : ''}${changed?.kind === 'changed' ? ' is-changed' : ''}${compact ? ' is-compact' : ''}`} data-setting={setting.id}>
      <div className="lu-setting-head">
        <span className="lu-setting-name" title={setting.description ?? setting.name}>{label}</span>
        {setting.title && <code className="lu-raw">{setting.name}</code>}
        {changed?.kind === 'changed' && <button className="lu-mark" onClick={() => clearMark(setting.id)} title="Dismiss">{changed.by === 'you' ? 'You' : changed.by} changed this</button>}
      </div>
      <div className="lu-setting-body">
        {setting.readOnly ? <span className="lu-readonly">{optionLabel(setting, setting.value)}</span>
          : setting.type === 'bool' && setting.options?.length === 2 ? (
            <button role="switch" aria-checked={String(draft).toUpperCase() === 'ON'} aria-label={label} className="lu-switch" disabled={busy} onClick={() => setDraft(String(draft).toUpperCase() === 'ON' ? 'OFF' : 'ON')}><i /></button>
          ) : setting.options ? (
            setting.options.length <= 4 && setting.options.reduce((n, o) => n + o.label.length, 0) <= 26 && !compact
              ? <div className="lu-segments" role="radiogroup" aria-label={label}>{setting.options.map(o => <button key={String(o.value)} role="radio" aria-checked={String(draft).toLowerCase() === String(o.value).toLowerCase()} disabled={busy} onClick={() => setDraft(o.value)}>{o.label}</button>)}</div>
              : <select aria-label={label} value={String(draft)} disabled={busy} onChange={e => setDraft(setting.options!.find(o => String(o.value) === e.target.value)?.value ?? e.target.value)}>{setting.options.map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}</select>
          ) : setting.type === 'number' ? (
            <div className="lu-stepper">
              <button aria-label={`Lower ${label}`} disabled={busy} onClick={() => setDraft(clamp(Number(draft) - step))}><Minus size={14} /></button>
              <input aria-label={label} inputMode="decimal" value={String(draft)} disabled={busy} onChange={e => setDraft(e.target.value)} onBlur={() => { const n = Number(draft); setDraft(Number.isFinite(n) && String(draft).trim() !== '' ? clamp(n) : setting.value); }} />
              <button aria-label={`Raise ${label}`} disabled={busy} onClick={() => setDraft(clamp(Number(draft) + step))}><Plus size={14} /></button>
              {setting.unit && <span className="lu-unit">{setting.unit}</span>}
            </div>
          ) : <input className="lu-text" aria-label={label} value={String(draft)} disabled={busy} onChange={e => setDraft(e.target.value)} />}
        {dirty && (
          <div className="lu-pending">
            <span className="lu-from">{optionLabel(setting, setting.value)}</span><span aria-hidden>→</span><span className="lu-to">{optionLabel(setting, draft)}</span>
            <button className="lu-apply" disabled={busy || !ready} onClick={apply} aria-label={`Apply ${label}`}><Check size={15} strokeWidth={2.6} /></button>
            <button className="lu-cancel" disabled={busy} onClick={() => { setDraft(setting.value); setConfirmed([]); }} aria-label="Cancel"><X size={15} /></button>
          </div>
        )}
      </div>
      {dirty && <Conditions needs={needs} value={confirmed} onChange={setConfirmed} />}
      {dirty && setting.rebootRequired && <p className="lu-hint">Needs a restart</p>}
      {setting.min !== undefined && setting.max !== undefined && dirty && <p className="lu-hint">{format(setting.min)} – {format(setting.max, setting.unit)}</p>}
    </div>
  );
}
