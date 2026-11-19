import { useMemo, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import type { PartId } from '../device/types';
import { api } from '../platform/cloud';
import { SettingControl } from './controls';
import { loadSettings, runTest } from './controller';
import { format, optionLabel, PART_NAME } from './parts';
import { useStore, type DocMeta } from './store';

/** Every setting the aircraft has, searchable. The exact-work view, one step from any part. */
export function SettingsView() {
  const settings = useStore(s => s.settings), snap = useStore(s => s.snap), part = useStore(s => s.part), docs = useStore(s => s.docs), busy = useStore(s => !!s.busy);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<PartId | undefined>(part), [open, setOpen] = useState<string>(), [limit, setLimit] = useState(120);
  const [diff, setDiff] = useState<{ name: string; rows: { id: string; then: unknown; now: unknown }[] }>();
  const parts = useMemo(() => [...new Set(settings.map(s => s.part))], [settings]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = useMemo(() => settings.filter(s => (!filter || s.part === filter) && words.every(w => `${s.id} ${s.title ?? ''} ${s.group} ${s.description ?? ''}`.toLowerCase().includes(w))), [settings, filter, query]);
  const snapshots = docs.filter(d => d.kind === 'snapshot');
  const backup = snap.tests.find(t => t.id === 'settings.snapshot');
  const compare = async (doc: DocMeta) => {
    const saved = (await api('GET', `/docs/${doc.id}`)).content.values as Record<string, unknown>;
    const same = (a: unknown, b: unknown) => String(a) === String(b) || (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= Math.max(1e-6, Math.abs(Number(b)) * 1e-5));
    setDiff({ name: doc.name, rows: settings.flatMap(s => { const name = s.id.replace(/^(param|bf)\./, ''); return name in saved && !same(saved[name], s.value) ? [{ id: s.id, then: saved[name], now: s.value }] : []; }) });
  };
  if (snap.status !== 'connected') return <div className="lu-empty"><h2>No drone connected</h2></div>;
  return (
    <section className="lu-page">
      <header className="lu-page-head">
        <h1>All settings</h1>
        <label className="lu-search"><Search size={16} /><input placeholder="Search" value={query} onChange={e => { setQuery(e.target.value); setLimit(120); }} aria-label="Search settings" /></label>
        <span className="lu-count">{rows.length} of {settings.length}</span>
        {backup && <button className="lu-btn" disabled={busy} onClick={() => runTest(backup)}>Back up</button>}
        {snap.settingsLoaded !== 'complete' && <button className="lu-btn is-primary" disabled={busy} onClick={loadSettings}>Read settings</button>}
      </header>
      <nav className="lu-chips" aria-label="Parts">
        <button className={!filter ? 'is-on' : ''} onClick={() => setFilter(undefined)}>All</button>
        {parts.map(p => <button key={p} className={filter === p ? 'is-on' : ''} onClick={() => setFilter(p)}>{PART_NAME[p]}</button>)}
      </nav>
      {snapshots.length > 0 && (
        <div className="lu-snapshots">
          <span>Backups</span>
          {snapshots.slice(0, 6).map(d => <button key={d.id} className="lu-link" onClick={() => compare(d)}>{d.name}</button>)}
        </div>
      )}
      {diff && (
        <div className="lu-diffbox" role="region" aria-label="Changes since backup">
          <header><b>{diff.rows.length} changed</b> since {diff.name}<button className="lu-link" onClick={() => setDiff(undefined)}>Close</button></header>
          {diff.rows.slice(0, 40).map(r => <div className="lu-diff" key={r.id}><span className="lu-diff-name">{r.id.replace(/^(param|bf)\./, '')}</span><span className="lu-from">{format(r.then)}</span><ArrowRight size={14} aria-hidden /><span className="lu-to">{format(r.now)}</span></div>)}
        </div>
      )}
      <div className="lu-table" role="list">
        {rows.slice(0, limit).map(s => (
          <div key={s.id} role="listitem" className={`lu-rowitem${open === s.id ? ' is-open' : ''}`}>
            {open === s.id ? <div className="lu-rowopen"><SettingControl setting={s} />{s.description && <p className="lu-desc">{s.description}</p>}</div>
              : <button className="lu-rowbtn" onClick={() => setOpen(s.id)}><span className="lu-rowname">{s.title ?? s.name}</span><code>{s.name}</code><span className="lu-rowvalue">{optionLabel(s, s.value)}{s.unit ? ` ${s.unit}` : ''}</span></button>}
          </div>
        ))}
        {rows.length > limit && <button className="lu-link lu-all" onClick={() => setLimit(limit + 300)}>Show more</button>}
        {!rows.length && <p className="lu-hint">{snap.settingsLoaded === 'loading' ? 'Reading settings…' : 'Nothing matches'}</p>}
      </div>
    </section>
  );
}
