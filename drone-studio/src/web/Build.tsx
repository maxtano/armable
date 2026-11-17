import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Bot, Check, ChevronDown, ExternalLink, PackageCheck, Plus, Search, Sparkles, Trash2, X } from 'lucide-react';
import { alternatives, analyse, cellRange, compareBuilds, emptyBuild, provenBuild, resolve, SLOT_LABEL, SLOTS, STYLES, type Build as BuildDoc, type BuildOp, type Check as BuildCheck, type Fit, type Goal, type Item } from '../build/build';
import { PROVEN, type Category, type Video } from '../build/catalog';
import { api, ApiError } from './cloud';
import { publishFocus, refreshDocs } from './controller';
import { set, toast, useStore } from './store';
import './build.css';

/**
 * Build a drone. The controls here and an assistant's tools edit the same build through the same operations,
 * so the checks, cost and weight agree.
 */

type Loaded = { id: string; revision: number; name: string; content: BuildDoc };
const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const VIDEOS: [Video, string][] = [['analog', 'Analog'], ['dji', 'DJI'], ['walksnail', 'Walksnail'], ['hdzero', 'HDZero']];
const STYLE_LABEL: Record<string, string> = { freestyle: 'Freestyle', cinematic: 'Cinematic', 'long-range': 'Long range', racing: 'Racing', whoop: 'Tiny whoop', other: 'Other' };
const SIZES = [1.6, 2.5, 3, 3.5, 5, 7];
const ago = (at: number) => { const s = Math.round((Date.now() - at) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(at).toLocaleDateString(); };

async function createBuild(name: string, operations: BuildOp[]): Promise<string> {
  const content = operations.length ? (await import('../build/build')).applyBuildOps(emptyBuild(), operations, 'you') : emptyBuild();
  const made = await api('POST', '/docs', { kind: 'build', name, content });
  await refreshDocs();
  set({ build: made.id, buildTab: 'mine' });
  return made.id;
}

export function Build() {
  const docs = useStore(s => s.docs.filter(d => d.kind === 'build'));
  const tab = useStore(s => s.buildTab ?? 'mine'), selected = useStore(s => s.build), rev = useStore(s => s.docRevision);
  const [loaded, setLoaded] = useState<Loaded>();
  const id = docs.find(d => d.id === selected)?.id ?? docs[0]?.id;
  const signature = docs.map(d => `${d.id}:${d.revision}`).join(',');
  useEffect(() => {
    if (!id) { setLoaded(undefined); return; }
    let alive = true;
    api('GET', `/docs/${id}`).then(full => { if (alive) setLoaded({ id: full.id, revision: full.revision, name: full.name, content: full.content }); }, () => {});
    publishFocus({ document: id });
    return () => { alive = false; };
  }, [id, signature, rev]);

  const apply = async (operations: BuildOp[], name?: string) => {
    if (!loaded) return;
    try {
      const saved = await api('POST', `/docs/${loaded.id}/ops`, { baseRevision: loaded.revision, operations, name });
      setLoaded({ ...loaded, revision: saved.revision, content: saved.content, name: name ?? loaded.name });
      void refreshDocs();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale') { toast('This build changed at the same moment. Showing the latest version; try again.', 'info'); set(s => ({ docRevision: s.docRevision + 1 })); }
      else toast(error instanceof Error ? error.message : 'That did not work.', 'bad');
    }
  };

  return (
    <section className="lu-page bd">
      <header className="lu-page-head">
        <h1>Build a drone</h1>
        <div className="lu-segments" role="radiogroup" aria-label="Build views">
          {([['mine', docs.length ? 'My builds' : 'Start'], ['proven', 'Proven builds'], ['compare', 'Compare']] as const).map(([value, label]) => (
            <button key={value} role="radio" aria-checked={tab === value} onClick={() => set({ buildTab: value })}>{label}</button>
          ))}
        </div>
      </header>
      {tab === 'proven' ? <ProvenList /> : tab === 'compare' ? <Compare current={loaded} /> : !docs.length ? <Start /> : (
        loaded ? <Sheet build={loaded} apply={apply} docs={docs} /> : <div className="lu-empty"><h2>Loading the build</h2></div>
      )}
    </section>
  );
}

// ---- Starting ----------------------------------------------------------------------------------------------------

function Start() {
  const [style, setStyle] = useState<Goal['style']>('freestyle'), [budget, setBudget] = useState('500'), [video, setVideo] = useState<Video | undefined>();
  const [owns, setOwns] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const size = style === 'whoop' ? 1.6 : style === 'long-range' ? 7 : style === 'cinematic' ? 3.5 : 5;
  const start = async () => {
    setBusy(true);
    try { await createBuild(`${STYLE_LABEL[style ?? 'other']} build`, [{ op: 'goal', set: { style, propIn: size, budgetUsd: Number(budget) || undefined, video, owns: owns as Goal['owns'] } }]); }
    catch (error) { toast(error instanceof Error ? error.message : 'Could not start the build.', 'bad'); }
    finally { setBusy(false); }
  };
  return (
    <div className="bd-start">
      <div className="bd-start-copy">
        <h2>Don’t have a drone? <em>Build one.</em></h2>
        <p>Say what you want to fly. Pick parts that work together, see what they cost and where to buy them, and swap anything.</p>
      </div>
      <div className="lu-card bd-goal-card">
        <h3>What do you want to fly?</h3>
        <nav className="lu-chips" aria-label="Flying style">{STYLES.filter(s => s !== 'other').map(s => <button key={s} className={style === s ? 'is-on' : ''} onClick={() => setStyle(s)}>{STYLE_LABEL[s]}</button>)}</nav>
        <div className="lu-row">
          <label className="bd-field">Budget<span className="bd-money"><i>$</i><input inputMode="numeric" value={budget} onChange={e => setBudget(e.target.value.replace(/[^\d]/g, ''))} aria-label="Budget in dollars" /></span></label>
          <label className="bd-field">Video<select value={video ?? ''} onChange={e => setVideo((e.target.value || undefined) as Video | undefined)}><option value="">Not sure</option>{VIDEOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </div>
        <div className="bd-owns"><span>I already have</span><nav className="lu-chips">{(['radio', 'goggles', 'charger'] as const).map(g => <button key={g} className={owns.includes(g) ? 'is-on' : ''} onClick={() => setOwns(owns.includes(g) ? owns.filter(x => x !== g) : [...owns, g])}>{owns.includes(g) && <Check size={13} />}{SLOT_LABEL[g]}</button>)}</nav></div>
        <button className="lu-btn is-primary is-big" disabled={busy} onClick={start}><Sparkles size={17} /> Start my build</button>
      </div>
      <h2 className="lu-sub">Or start from a build pilots already fly</h2>
      <ProvenList compact />
    </div>
  );
}

// ---- The build sheet ---------------------------------------------------------------------------------------------

function Sheet({ build, apply, docs }: { build: Loaded; apply: (ops: BuildOp[], name?: string) => Promise<void>; docs: { id: string; name: string }[] }) {
  const b = build.content, a = useMemo(() => analyse(b), [b]);
  const [picking, setPicking] = useState<Category | undefined>(), [name, setName] = useState(build.name), [focus, setFocus] = useState<string[]>([]);
  const marks = useStore(s => s.marks);
  useEffect(() => setName(build.name), [build.name]);
  const goal = (patch: Partial<Goal>) => void apply([{ op: 'goal', set: patch }]);
  const remove = async () => { if (!confirm(`Delete “${build.name}”?`)) return; await api('DELETE', `/docs/${build.id}`); set({ build: undefined }); await refreshDocs(); };
  const fresh = (item: Item) => Date.now() - item.at < 8000 && item.by !== 'you';
  const others = b.items.filter(i => i.category === 'other');
  const problems = a.checks.filter(c => c.level === 'fail').length, cautions = a.checks.filter(c => c.level === 'warn').length;
  return (
    <div className={`bd-sheet${marks[build.id]?.kind === 'changed' ? ' is-changed' : ''}`}>
      <div className="bd-sheet-head">
        <input className="bd-name" value={name} onChange={e => setName(e.target.value)} onBlur={() => { const n = name.trim(); if (n && n !== build.name) void apply([{ op: 'note', text: `Renamed to ${n}` }], n); }} aria-label="Build name" maxLength={80} />
        {docs.length > 1 && <select className="bd-switch" value={build.id} onChange={e => set({ build: e.target.value })} aria-label="Switch build">{docs.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
        <button className="lu-btn" onClick={() => void createBuild('New build', [])}><Plus size={14} /> New</button>
        <button className="lu-icon" onClick={remove} aria-label="Delete this build" title="Delete this build"><Trash2 size={16} /></button>
      </div>

      <div className="bd-goal">
        <nav className="lu-chips" aria-label="Flying style">{STYLES.map(s => <button key={s} className={b.goal.style === s ? 'is-on' : ''} onClick={() => goal({ style: s })}>{STYLE_LABEL[s]}</button>)}</nav>
        <div className="lu-row">
          <label className="bd-field">Size<select value={b.goal.propIn ?? ''} onChange={e => goal({ propIn: Number(e.target.value) || undefined })}><option value="">Any</option>{SIZES.map(s => <option key={s} value={s}>{s}"</option>)}</select></label>
          <label className="bd-field">Video<select value={b.goal.video ?? ''} onChange={e => e.target.value && goal({ video: e.target.value as Video })}><option value="">Any</option>{VIDEOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="bd-field">Budget<span className="bd-money"><i>$</i><input key={b.goal.budgetUsd} inputMode="numeric" defaultValue={b.goal.budgetUsd ?? ''} onBlur={e => { const n = Number(e.target.value.replace(/[^\d.]/g, '')); if (n && n !== b.goal.budgetUsd) goal({ budgetUsd: n }); }} aria-label="Budget in dollars" /></span></label>
          <span className="bd-owns"><span>I have</span><nav className="lu-chips">{(['radio', 'goggles', 'charger'] as const).map(g => { const on = b.goal.owns?.includes(g); return <button key={g} className={on ? 'is-on' : ''} onClick={() => goal({ owns: on ? b.goal.owns!.filter(x => x !== g) : [...(b.goal.owns ?? []), g] })}>{on && <Check size={13} />}{SLOT_LABEL[g]}</button>; })}</nav></span>
        </div>
      </div>

      <div className="bd-stats">
        <Stat label="Parts to buy" value={money(a.costUsd)} sub={a.budgetLeftUsd === undefined ? undefined : a.budgetLeftUsd >= 0 ? `${money(a.budgetLeftUsd)} under budget` : `${money(-a.budgetLeftUsd)} over budget`} tone={a.budgetLeftUsd !== undefined && a.budgetLeftUsd < 0 ? 'warn' : undefined} />
        <Stat label="Take-off weight" value={a.weightG ? `${a.weightG} g` : '—'} sub={a.weightG ? (a.weightG < 250 ? 'Under 250 g' : 'Register it') : 'Needs frame, motors, stack, props, battery'} />
        <Stat label="Thrust to weight" value={a.thrustToWeight ? `${a.thrustToWeight}:1` : '—'} />
        <Stat label="Flight time" value={a.flightMinutes ? `${a.flightMinutes[0]}–${a.flightMinutes[1]} min` : '—'} sub={a.flightMinutes ? 'Rough estimate' : undefined} />
        <Stat label="Status" value={problems ? `${problems} won’t work` : a.complete ? 'Ready to order' : 'In progress'} sub={cautions ? `${cautions} to watch` : undefined} tone={problems ? 'bad' : a.complete && !cautions ? 'ok' : undefined} />
      </div>

      {a.checks.some(c => c.level !== 'ok') && (
        <ul className="bd-checks" aria-label="Checks">
          {a.checks.filter(c => c.level !== 'ok').map(c => <CheckRow key={c.text} check={c} onPick={() => { setFocus(c.slots); const s = c.slots.find(x => !b.items.some(i => i.slot === x)); if (s && c.level === 'todo') setPicking(s as Category); }} />)}
        </ul>
      )}

      <div className="bd-parts" role="table" aria-label="Parts">
        {SLOTS.filter(slot => !slot.gear).map(slot => {
          const item = b.items.find(i => i.slot === slot.id);
          if (item) return <PartRow key={slot.id} item={item} apply={apply} onSwap={() => setPicking(slot.id)} lit={focus.includes(slot.id)} fresh={fresh(item)} />;
          const covered = (slot.id === 'camera' || slot.id === 'receiver' || slot.id === 'antenna') && !a.checks.some(c => c.slots.includes(slot.id) && c.level !== 'info');
          return <EmptyRow key={slot.id} label={slot.label} optional={!slot.needed} covered={covered && !!slot.needed} onPick={() => setPicking(slot.id)} lit={focus.includes(slot.id)} />;
        })}
        {others.map(item => <PartRow key={item.slot} item={item} apply={apply} lit={false} fresh={fresh(item)} />)}
        <button className="bd-add-other" onClick={() => setPicking('other')}><Plus size={14} /> Add a part you found</button>
        <div className="bd-divider">To fly it</div>
        {SLOTS.filter(slot => slot.gear).map(slot => {
          const item = b.items.find(i => i.slot === slot.id);
          if (item) return <PartRow key={slot.id} item={item} apply={apply} onSwap={() => setPicking(slot.id)} lit={focus.includes(slot.id)} fresh={fresh(item)} />;
          if (b.goal.owns?.includes(slot.id as 'radio')) return <div key={slot.id} className="bd-row is-empty" role="row"><span className="bd-slot" role="cell">{slot.label}</span><div className="bd-what" role="cell"><small>You have one</small></div></div>;
          return <EmptyRow key={slot.id} label={slot.label} optional onPick={() => setPicking(slot.id)} lit={focus.includes(slot.id)} />;
        })}
      </div>
      <p className="lu-hint">Prices marked “typical” are a guide, not live. Prices someone looked up show where and when they were seen. Store links search each shop for the part.</p>
      {picking && <Picker build={b} category={picking} onClose={() => setPicking(undefined)} apply={async ops => { await apply(ops); setPicking(undefined); }} />}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return <div className={`bd-stat${tone ? ` is-${tone}` : ''}`}><small>{label}</small><b>{value}</b>{sub && <span>{sub}</span>}</div>;
}

function CheckRow({ check, onPick }: { check: BuildCheck; onPick: () => void }) {
  const word = { fail: 'Won’t work', warn: 'Watch', todo: 'To do', info: 'Note', ok: 'Good' }[check.level];
  return <li className={`bd-check is-${check.level}`}><button onClick={onPick}><b>{word}</b><span>{check.text}</span></button></li>;
}

function specLine(item: Item): string {
  const r = resolve(item), s = r.specs;
  return [s.kv && `${s.kv} KV`, s.stator, s.cells && cellRange(s.cells), s.series && `${s.series}S ${s.mah} mAh ${s.chem ?? ''}`.trim(), s.propIn && `${s.propIn}"`, s.mounts && `${s.mounts.join(' / ')}${s.mounts[0] === 'whoop' ? '' : ' mm'}`, s.amps && item.category === 'stack' && `${s.amps} A`, s.video && VIDEOS.find(v => v[0] === s.video)?.[1], s.link, s.includes?.length && `includes ${s.includes.join(', ')}`, r.weightG !== undefined && `${r.weightG} g`].filter(Boolean).join(' · ');
}

function PartRow({ item, apply, onSwap, lit, fresh }: { item: Item; apply: (ops: BuildOp[]) => Promise<void>; onSwap?: () => void; lit: boolean; fresh: boolean }) {
  const r = resolve(item), [links, setLinks] = useState(false);
  const total = r.unitUsd !== undefined ? r.unitUsd * item.qty : undefined;
  return (
    <div className={`bd-row${item.owned ? ' is-owned' : ''}${lit ? ' is-lit' : ''}${fresh ? ' is-fresh' : ''}`} role="row">
      <span className="bd-slot" role="cell">{SLOT_LABEL[item.category]}</span>
      <div className="bd-what" role="cell">
        <b>{r.brand && <span>{r.brand} </span>}{r.name}</b>
        <small>{specLine(item)}</small>
        {item.note && <em>{item.note}</em>}
        {item.by !== 'you' && <i className="bd-by"><Bot size={11} /> {item.by}</i>}
      </div>
      <div className="bd-qty" role="cell">
        <div className="lu-stepper">
          <button onClick={() => item.qty > 1 && void apply([{ op: 'qty', slot: item.slot, qty: item.qty - 1 }])} disabled={item.qty <= 1} aria-label="Fewer">−</button>
          <input value={item.qty} readOnly aria-label="Quantity" />
          <button onClick={() => void apply([{ op: 'qty', slot: item.slot, qty: item.qty + 1 }])} aria-label="More">+</button>
        </div>
      </div>
      <div className="bd-price" role="cell">
        <b>{total !== undefined ? money(total) : '—'}</b>
        <small>{item.owned ? 'Owned' : r.priceSource === 'seen' ? `${money(r.unitUsd!)} at ${item.price?.store ?? 'store'} · ${ago(item.price!.at)}` : r.priceSource === 'typical' ? `${item.qty > 1 ? `${money(r.unitUsd!)} each · ` : ''}typical` : 'No price'}</small>
      </div>
      <div className="bd-actions" role="cell">
        <div className="bd-buy">
          <button className="lu-btn" onClick={() => setLinks(!links)} aria-expanded={links}>Buy <ChevronDown size={13} /></button>
          {links && <div className="bd-links" onMouseLeave={() => setLinks(false)}>{r.links.map(l => <a key={l.store + l.url} href={l.url} target="_blank" rel="noreferrer noopener">{l.store}<ExternalLink size={12} /></a>)}{r.maker && <a href={r.maker} target="_blank" rel="noreferrer noopener">{r.brand} site<ExternalLink size={12} /></a>}</div>}
        </div>
        {onSwap && <button className="lu-icon" onClick={onSwap} aria-label={`Swap the ${SLOT_LABEL[item.category]}`} title="Compare and swap"><ArrowLeftRight size={15} /></button>}
        <button className={`lu-icon${item.owned ? ' is-on' : ''}`} onClick={() => void apply([{ op: 'own', slot: item.slot, owned: !item.owned }])} aria-pressed={!!item.owned} aria-label="I already have this" title="I already have this"><PackageCheck size={15} /></button>
        <button className="lu-icon" onClick={() => void apply([{ op: 'remove', slot: item.slot }])} aria-label="Remove" title="Remove"><X size={15} /></button>
      </div>
    </div>
  );
}

function EmptyRow({ label, optional, covered, onPick, lit }: { label: string; optional?: boolean; covered?: boolean; onPick: () => void; lit: boolean }) {
  return (
    <div className={`bd-row is-empty${lit ? ' is-lit' : ''}`} role="row">
      <span className="bd-slot" role="cell">{label}</span>
      <div className="bd-what" role="cell"><small>{covered ? 'Included with another part' : optional ? 'Optional' : 'Not chosen yet'}</small></div>
      {!covered && <button className="lu-link" onClick={onPick}><Plus size={14} /> Choose</button>}
    </div>
  );
}

// ---- Choosing and comparing parts --------------------------------------------------------------------------------

function Picker({ build, category, onClose, apply }: { build: BuildDoc; category: Category; onClose: () => void; apply: (ops: BuildOp[]) => Promise<void> }) {
  const [query, setQuery] = useState(''), [mode, setMode] = useState<'catalog' | 'custom'>(category === 'other' ? 'custom' : 'catalog');
  const current = build.items.find(i => i.slot === category);
  const fits = useMemo(() => category === 'other' ? [] : alternatives(build, category, 40), [build, category]);
  const shown = fits.filter(f => !query || `${f.part.brand} ${f.part.name} ${f.part.blurb}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="lu-scrim" role="dialog" aria-modal aria-label={`Choose ${SLOT_LABEL[category]}`} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bd-picker">
        <header><h2>{current ? `Swap the ${SLOT_LABEL[category].toLowerCase()}` : `Choose ${SLOT_LABEL[category].toLowerCase()}`}</h2><button className="lu-icon" onClick={onClose} aria-label="Close"><X size={17} /></button></header>
        {category !== 'other' && <div className="lu-segments" role="radiogroup"><button role="radio" aria-checked={mode === 'catalog'} onClick={() => setMode('catalog')}>Catalog</button><button role="radio" aria-checked={mode === 'custom'} onClick={() => setMode('custom')}>A part I found</button></div>}
        {mode === 'catalog' ? (
          <>
            {current && <p className="lu-hint">Now: <b>{resolve(current).brand} {resolve(current).name}</b>. Best fit first, then cheapest; differences are for this build.</p>}
            <label className="lu-search"><Search size={15} /><input autoFocus placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} /></label>
            <ul className="bd-options">{shown.map(f => <Option key={f.part.id} fit={f} swap={!!current} onAdd={() => apply([{ op: 'add', part: f.part.id }])} />)}</ul>
            {!shown.length && <p className="lu-hint">Nothing in the catalog matches. Add a part you found instead.</p>}
          </>
        ) : <CustomForm category={category} onAdd={op => apply([op])} />}
      </div>
    </div>
  );
}

function Option({ fit, swap, onAdd }: { fit: Fit; swap: boolean; onAdd: () => void }) {
  const p = fit.part, item: Item = { slot: p.category, category: p.category, part: p.id, qty: p.qty ?? 1, by: 'you', at: 0 };
  return (
    <li className={`bd-option is-${fit.fit}`}>
      <div><b>{p.brand} {p.name}</b><small>{specLine(item)}</small><span>{p.blurb}</span>{fit.problems.map(t => <em key={t}>{t}</em>)}</div>
      <div className="bd-option-side">
        <i className={`bd-fit is-${fit.fit}`}>{fit.fit === 'fits' ? 'Fits' : fit.fit === 'warn' ? 'Works, with a catch' : 'Won’t fit'}</i>
        <b>{money(p.priceUsd)}{(p.qty ?? 1) > 1 && <small> each</small>}</b>
        {swap && <small>{fit.costDeltaUsd === 0 ? 'Same cost' : `${fit.costDeltaUsd > 0 ? '+' : '−'}${money(Math.abs(fit.costDeltaUsd))}`}{fit.weightDeltaG ? ` · ${fit.weightDeltaG > 0 ? '+' : '−'}${Math.abs(fit.weightDeltaG)} g` : ''}</small>}
        <button className="lu-btn is-primary" onClick={onAdd}>{swap ? 'Swap in' : 'Add'}</button>
      </div>
    </li>
  );
}

function CustomForm({ category, onAdd }: { category: Category; onAdd: (op: BuildOp) => void }) {
  const [f, setF] = useState({ category, name: '', brand: '', price: '', url: '', weight: '', store: '' });
  const field = (key: keyof typeof f) => ({ value: f[key], onChange: (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value }) });
  const valid = f.name.trim() && (!f.url || /^https:\/\//.test(f.url));
  return (
    <form className="bd-custom" onSubmit={e => { e.preventDefault(); if (!valid) return; onAdd({ op: 'custom', category: f.category, name: f.name.trim(), brand: f.brand.trim() || undefined, priceUsd: f.price ? Number(f.price) : undefined, url: f.url || undefined, store: f.store.trim() || (f.url ? new URL(f.url).hostname.replace(/^www\./, '') : undefined), weightG: f.weight ? Number(f.weight) : undefined }); }}>
      <label>Kind of part<select {...field('category')} onChange={e => setF({ ...f, category: e.target.value as Category })}>{[...SLOTS.map(s => s.id), 'other'].map(c => <option key={c} value={c}>{SLOT_LABEL[c]}</option>)}</select></label>
      <label>Name<input required maxLength={80} placeholder="e.g. Xing2 2306 1755KV" {...field('name')} /></label>
      <label>Brand<input maxLength={40} {...field('brand')} /></label>
      <div className="lu-row"><label>Price (USD)<input inputMode="decimal" {...field('price')} /></label><label>Weight (g)<input inputMode="decimal" {...field('weight')} /></label></div>
      <label>Link<input type="url" placeholder="https://" {...field('url')} /></label>
      <button className="lu-btn is-primary" disabled={!valid}><Plus size={14} /> Add to the build</button>
    </form>
  );
}

// ---- Proven builds and comparison --------------------------------------------------------------------------------

function ProvenList({ compact }: { compact?: boolean }) {
  const [open, setOpen] = useState<string>();
  const start = async (id: string, name: string) => { await createBuild(name, [{ op: 'from', build: id }]); set({ buildTab: 'mine' }); toast(`Started from “${name}”. Change anything you like.`, 'ok'); };
  return (
    <div className={`bd-proven${compact ? ' is-compact' : ''}`}>
      {PROVEN.map(p => {
        const build = provenBuild(p.id), a = analyse(build), expanded = open === p.id;
        return (
          <article key={p.id} className="lu-card bd-proven-card">
            <header><h3>{p.name}</h3><b>{money(a.costUsd)}</b></header>
            <nav className="bd-tags"><span>{STYLE_LABEL[p.style]}</span><span>{p.propIn}"</span><span>{VIDEOS.find(v => v[0] === p.video)?.[1]}</span>{a.weightG && <span>{a.weightG} g</span>}{a.flightMinutes && <span>{a.flightMinutes[0]}–{a.flightMinutes[1]} min</span>}</nav>
            <p>{p.summary}</p>
            {expanded && <>
              <p className="lu-hint">{p.why}</p>
              <ul className="bd-proven-parts">{build.items.map(i => { const r = resolve(i); return <li key={i.slot}><span>{SLOT_LABEL[i.category]}</span><a href={r.links[0].url} target="_blank" rel="noreferrer noopener">{r.brand} {r.name}<ExternalLink size={11} /></a><b>{i.qty > 1 ? `${i.qty} × ` : ''}{money(r.unitUsd!)}</b></li>; })}</ul>
              <p className="lu-hint">Typical prices. Radio, goggles and charger not included.</p>
            </>}
            <div className="lu-row"><button className="lu-btn is-primary" onClick={() => void start(p.id, p.name)}>Start from this</button><button className="lu-link" onClick={() => setOpen(expanded ? undefined : p.id)}>{expanded ? 'Hide parts' : 'Parts and prices'}</button>{!compact && <button className="lu-link" onClick={() => set({ buildTab: 'compare', compare: [p.id] })}>Compare</button>}</div>
          </article>
        );
      })}
    </div>
  );
}

function Compare({ current }: { current?: Loaded }) {
  const docs = useStore(s => s.docs.filter(d => d.kind === 'build'));
  const chosen = useStore(s => s.compare ?? []);
  const [loaded, setLoaded] = useState<Record<string, { name: string; content: BuildDoc }>>({});
  const initial = chosen.length ? chosen : [current?.id, PROVEN[0].id].filter(Boolean) as string[];
  useEffect(() => { if (!chosen.length && initial.length) set({ compare: initial }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const picks = chosen.length ? chosen : initial;
  useEffect(() => {
    for (const id of picks.filter(id => id.startsWith('build_') && !loaded[id])) api('GET', `/docs/${id}`).then(full => setLoaded(l => ({ ...l, [id]: { name: full.name, content: full.content } })), () => {});
  }, [picks.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => set({ compare: picks.includes(id) ? picks.filter(x => x !== id) : [...picks, id].slice(-4) });
  const list = picks.map(id => id.startsWith('proven.') ? { name: PROVEN.find(p => p.id === id)!.name, build: provenBuild(id) } : loaded[id] ? { name: loaded[id].name, build: loaded[id].content } : undefined).filter(Boolean) as { name: string; build: BuildDoc }[];
  const table = compareBuilds(list);
  return (
    <div className="bd-compare">
      <nav className="lu-chips" aria-label="Builds to compare">
        {docs.map(d => <button key={d.id} className={picks.includes(d.id) ? 'is-on' : ''} onClick={() => toggle(d.id)}>{picks.includes(d.id) && <Check size={13} />}{d.name}</button>)}
        {PROVEN.map(p => <button key={p.id} className={picks.includes(p.id) ? 'is-on' : ''} onClick={() => toggle(p.id)}>{picks.includes(p.id) && <Check size={13} />}{p.name}</button>)}
      </nav>
      {list.length < 2 ? <p className="lu-hint">Pick two to four builds to compare.</p> : (
        <div className="bd-table" style={{ gridTemplateColumns: `minmax(120px, 0.7fr) repeat(${list.length}, minmax(150px, 1fr))` }} role="table">
          <span role="columnheader" />{table.names.map((n, i) => <b key={i} role="columnheader">{n}</b>)}
          {table.rows.map(row => [<span key={row.label} role="rowheader">{row.label}</span>, ...row.values.map((v, i) => <span key={`${row.label}${i}`} role="cell" className={row.best === i ? 'is-best' : ''}>{v ?? '—'}</span>)])}
        </div>
      )}
    </div>
  );
}
