import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Antenna, ArrowLeftRight, BatteryFull, Bot, Camera, Check, ChevronDown, Cog, Cpu, ExternalLink, Frame, Gamepad2, Glasses, ListFilter, Package, PackageCheck, PlugZap, Plus, RadioReceiver, RadioTower, Satellite, Search, Sparkles, Star, Trash2, Wind, X, type LucideIcon } from 'lucide-react';
import { analyse, cellRange, compareBuilds, emptyBuild, fitOf, groupOf, provenBuild, resolve, SLOT_LABEL, SLOTS, STYLES, type Build as BuildDoc, type BuildOp, type Check as BuildCheck, type Goal, type Item } from '../build/build';
import { PART_BY_ID, PARTS, PROVEN, storeLinks, type Category, type Part, type Video } from '../build/catalog';
import { api, ApiError } from './cloud';
import { publishFocus, refreshDocs } from './controller';
import { Coil, Dial, Lamp } from './Instruments';
import { PartArt, type Drawable } from './PartArt';
import { set, toast, useStore } from './store';
import './build.css';

/**
 * Build a drone. The controls here and an assistant's tools edit the same build through the same operations,
 * so the checks, cost and weight agree.
 */

type Loaded = { id: string; revision: number; name: string; content: BuildDoc };
type Apply = (ops: BuildOp[], name?: string) => Promise<void>;
const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const VIDEOS: [Video, string][] = [['analog', 'Analog'], ['dji', 'DJI'], ['walksnail', 'Walksnail'], ['hdzero', 'HDZero']];
const VIDEO_NAME = Object.fromEntries(VIDEOS) as Record<string, string>;
const STYLE_LABEL: Record<string, string> = { freestyle: 'Freestyle', cinematic: 'Cinematic', 'long-range': 'Long range', racing: 'Racing', whoop: 'Tiny whoop', other: 'Other' };
const SIZES = [1.6, 2.5, 3, 3.5, 5, 7];
const ago = (at: number) => { const s = Math.round((Date.now() - at) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(at).toLocaleDateString(); };
export const ICON: Record<string, LucideIcon> = { frame: Frame, motors: Cog, stack: Cpu, props: Wind, battery: BatteryFull, receiver: RadioReceiver, vtx: RadioTower, camera: Camera, antenna: Antenna, gps: Satellite, radio: Gamepad2, goggles: Glasses, charger: PlugZap, other: Package };
const GROUPS: { id: 'essential' | 'extra' | 'gear'; title: string; hint: string }[] = [
  { id: 'essential', title: 'Essentials', hint: 'What it takes to fly' },
  { id: 'extra', title: 'Extras', hint: 'Not required, often worth it' },
  { id: 'gear', title: 'To fly it', hint: 'Radio, goggles and charger, unless you have them' },
];
const CATEGORY_ORDER: Category[] = [...SLOTS.map(s => s.id), 'other'];
const drawable = (item: Item): Drawable => { const r = resolve(item); return { id: item.part, category: item.category, brand: r.brand, name: r.name, specs: r.specs }; };

// ---- Ratings, shared by everyone ---------------------------------------------------------------------------------

interface RatingSummary { average: number; count: number; histogram: number[]; mine?: { stars: number; review?: string } }
const Ratings = createContext<{ all: Record<string, RatingSummary>; reload(): void }>({ all: {}, reload() {} });
function RatingsProvider({ children }: { children: ReactNode }) {
  const [all, setAll] = useState<Record<string, RatingSummary>>({}), [tick, setTick] = useState(0);
  useEffect(() => { api('GET', '/ratings').then(setAll, () => {}); }, [tick]);
  return <Ratings.Provider value={{ all, reload: () => setTick(t => t + 1) }}>{children}</Ratings.Provider>;
}
function Stars({ value, size = 13 }: { value: number; size?: number }) {
  return <span className="bd-stars" aria-label={`${value} out of 5 stars`} role="img">{[1, 2, 3, 4, 5].map(n => <span key={n} className="bd-star"><Star size={size} /><i style={{ width: `${Math.max(0, Math.min(1, value - n + 1)) * 100}%` }}><Star size={size} /></i></span>)}</span>;
}
function RatingBadge({ part }: { part?: string }) {
  const r = useContext(Ratings).all[part ?? ''];
  if (!part || !PART_BY_ID.has(part)) return <span className="bd-rating is-none">—</span>;
  return r ? <span className="bd-rating"><Stars value={r.average} /><small>{r.average.toFixed(1)} ({r.count})</small></span> : <span className="bd-rating is-none">No ratings</span>;
}

// ---- The page ----------------------------------------------------------------------------------------------------

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

  const apply: Apply = async (operations, name) => {
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
    <RatingsProvider>
      <section className="lu-page bd">
        <header className="lu-page-head">
          <h1>Build a drone</h1>
          <div className="lu-segments" role="radiogroup" aria-label="Build views">
            {([['mine', docs.length ? 'My build' : 'Start'], ['parts', 'Browse parts'], ['proven', 'Proven builds'], ['compare', 'Compare']] as const).map(([value, label]) => (
              <button key={value} role="radio" aria-checked={tab === value} onClick={() => set({ buildTab: value })}>{label}</button>
            ))}
          </div>
        </header>
        {tab === 'proven' ? <ProvenList /> : tab === 'compare' ? <Compare current={loaded} /> : tab === 'parts' ? <Catalog build={loaded} apply={apply} />
          : !docs.length ? <Start /> : loaded ? <Sheet build={loaded} apply={apply} docs={docs} /> : <div className="lu-empty"><h2>Loading the build</h2></div>}
      </section>
    </RatingsProvider>
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
  const showcase = ['frame.apex-5', 'motor.velox-v2207-1950', 'stack.speedybee-f405-v4', 'props.ethix-s5', 'battery.rline-6s-1300', 'vtx.dji-o4-pro'].map(id => PART_BY_ID.get(id)!);
  return (
    <div className="bd-start">
      <div className="bd-hero">
        <div className="bd-start-copy">
          <Coil width={140} height={36} />
          <h2>Don’t have a drone? <em>Build one.</em></h2>
          <p>Pick every part, see that they work together, and know what it costs and where to buy it before you spend anything.</p>
        </div>
        <div className="bd-hero-art" aria-hidden>{showcase.map(p => <PartArt key={p.id} part={p} size={74} />)}</div>
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

function Sheet({ build, apply, docs }: { build: Loaded; apply: Apply; docs: { id: string; name: string }[] }) {
  const b = build.content, a = useMemo(() => analyse(b), [b]);
  const [picking, setPicking] = useState<Category | undefined>(), [detail, setDetail] = useState<string>(), [name, setName] = useState(build.name), [focus, setFocus] = useState<string[]>([]);
  useEffect(() => setName(build.name), [build.name]);
  const goal = (patch: Partial<Goal>) => void apply([{ op: 'goal', set: patch }]);
  const remove = async () => { if (!confirm(`Delete “${build.name}”?`)) return; await api('DELETE', `/docs/${build.id}`); set({ build: undefined }); await refreshDocs(); };
  const fresh = (item: Item) => Date.now() - item.at < 8000 && item.by !== 'you';
  const problems = a.checks.filter(c => c.level === 'fail'), cautions = a.checks.filter(c => c.level === 'warn');
  const suggested = PARTS.filter(p => p.category === 'other' && !b.items.some(i => i.part === p.id));
  const covered = (slot: string) => (slot === 'camera' || slot === 'receiver' || slot === 'antenna') && !a.checks.some(c => c.slots.includes(slot) && c.level !== 'info');
  const rowFor = (slot: { id: Category; label: string; needed?: boolean }) => {
    const item = b.items.find(i => i.slot === slot.id);
    if (item) return <PartRow key={slot.id} item={item} apply={apply} onSwap={() => setPicking(slot.id)} onOpen={() => item.part && setDetail(item.part)} lit={focus.includes(slot.id)} fresh={fresh(item)} />;
    if (groupOf(slot.id) === 'gear' && b.goal.owns?.includes(slot.id as 'radio')) return <EmptyRow key={slot.id} slot={slot.id} label={slot.label} note="You have one" lit={false} />;
    return <EmptyRow key={slot.id} slot={slot.id} label={slot.label} note={slot.needed && covered(slot.id) ? 'Included with another part' : undefined} optional={!slot.needed} onPick={() => setPicking(slot.id)} lit={focus.includes(slot.id)} />;
  };
  return (
    <div className="bd-sheet">
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

      <Gauges a={a} goal={b.goal} />

      <div className={`bd-compat is-${problems.length ? 'bad' : cautions.length ? 'warn' : 'ok'}`} role="status">
        <Lamp tone={problems.length ? 'bad' : cautions.length ? 'warn' : 'ok'} />
        <b>{problems.length ? `Compatibility: ${problems.length} problem${problems.length > 1 ? 's' : ''} found` : cautions.length ? `Compatibility: works, ${cautions.length} thing${cautions.length > 1 ? 's' : ''} to watch` : 'Compatibility: no problems found'}</b>
      </div>

      {a.checks.some(c => c.level !== 'ok') && (
        <ul className="bd-checks" aria-label="Checks">
          {a.checks.filter(c => c.level !== 'ok').map(c => <CheckRow key={c.text} check={c} onPick={() => { setFocus(c.slots); const s = c.slots.find(x => !b.items.some(i => i.slot === x)); if (s && c.level === 'todo') setPicking(s as Category); }} />)}
        </ul>
      )}

      <div className="bd-parts" role="table" aria-label="Parts">
        <div className="bd-head" role="row"><span role="columnheader">Component</span><span role="columnheader">Selection</span><span role="columnheader">Rating</span><span role="columnheader">Price</span><span role="columnheader" /></div>
        {GROUPS.map(g => (
          <div key={g.id} className="bd-group" role="rowgroup" aria-label={g.title}>
            <div className="bd-group-head"><b>{g.title}</b><small>{g.hint}</small></div>
            {SLOTS.filter(s => groupOf(s.id) === g.id).map(rowFor)}
            {g.id === 'extra' && b.items.filter(i => i.category === 'other').map(item => <PartRow key={item.slot} item={item} apply={apply} onOpen={() => item.part && setDetail(item.part)} lit={false} fresh={fresh(item)} />)}
            {g.id === 'extra' && (
              <div className="bd-suggest">
                {suggested.slice(0, 6).map(p => <button key={p.id} onClick={() => void apply([{ op: 'add', part: p.id }])} title={p.blurb}><PartArt part={p} size={30} /><span>{p.name}</span><small>{money(p.priceUsd)}</small><Plus size={13} /></button>)}
                <button className="is-own" onClick={() => setPicking('other')}><Package size={15} /><span>A part I found</span><Plus size={13} /></button>
              </div>
            )}
          </div>
        ))}
        <div className="bd-total" role="row">
          <span>{a.ownedUsd ? `${money(a.ownedUsd)} already owned, not counted` : ''}</span>
          <b>Total {money(a.costUsd)}</b>
          {a.budgetLeftUsd !== undefined && <small className={a.budgetLeftUsd < 0 ? 'is-over' : ''}>{a.budgetLeftUsd >= 0 ? `${money(a.budgetLeftUsd)} under budget` : `${money(-a.budgetLeftUsd)} over budget`}</small>}
        </div>
      </div>
      <p className="lu-hint">Prices marked “typical” are a guide, not live; prices someone looked up show where and when they were seen. Store links search each shop for the part. Drawings show the kind of part, not a product photo.</p>
      {picking && <Browser build={b} category={picking} onClose={() => setPicking(undefined)} onOpen={setDetail} apply={async ops => { await apply(ops); setPicking(undefined); }} />}
      {detail && <Detail id={detail} build={b} onClose={() => setDetail(undefined)} apply={async ops => { await apply(ops); setDetail(undefined); }} />}
    </div>
  );
}

/** The build at a glance, on four dials. */
function Gauges({ a, goal }: { a: ReturnType<typeof analyse>; goal: Goal }) {
  const budget = goal.budgetUsd, costMax = Math.max(budget ? budget * 1.4 : 0, a.costUsd * 1.25, 200);
  const weightMax = Math.max(1000, (a.weightG ?? 0) * 1.25), mid = a.flightMinutes ? (a.flightMinutes[0] + a.flightMinutes[1]) / 2 : undefined;
  return (
    <div className="lu-dials" aria-label="The build at a glance">
      <Dial label="Cost" reading={money(a.costUsd)} value={a.costUsd} max={costMax} marks={budget ? [{ at: budget, label: 'Budget' }] : []} caution={budget ? [budget, costMax] : undefined}
        note={budget === undefined ? 'No budget set' : a.budgetLeftUsd! >= 0 ? `${money(a.budgetLeftUsd!)} left` : `${money(-a.budgetLeftUsd!)} over`} tone={budget && a.costUsd > budget ? 'warn' : undefined} />
      <Dial label="Take-off weight" reading={a.weightG ? `${a.weightG} g` : '—'} value={a.weightG} max={weightMax} marks={[{ at: 250, label: '250 g' }]} note={a.weightG ? (a.weightG < 250 ? 'Under 250 g' : 'Needs registering') : 'Add the main parts'} />
      <Dial label="Thrust to weight" reading={a.thrustToWeight ? `${a.thrustToWeight} : 1` : '—'} value={a.thrustToWeight} max={16} caution={[0, 3]} note={a.thrustToWeight ? (a.thrustToWeight >= 6 ? 'Punchy' : a.thrustToWeight >= 3 ? 'Smooth' : 'Too heavy') : undefined} tone={a.thrustToWeight !== undefined && a.thrustToWeight < 3 ? 'bad' : undefined} />
      <Dial label="Flight time" reading={a.flightMinutes ? `${a.flightMinutes[0]}–${a.flightMinutes[1]} min` : '—'} value={mid} max={Math.max(30, (mid ?? 0) * 1.2)} note={a.flightMinutes ? 'Rough estimate' : undefined} />
    </div>
  );
}

function CheckRow({ check, onPick }: { check: BuildCheck; onPick: () => void }) {
  const word = { fail: 'Won’t work', warn: 'Watch', todo: 'To do', info: 'Note', ok: 'Good' }[check.level];
  return <li className={`bd-check is-${check.level}`}><button onClick={onPick}><b>{word}</b><span>{check.text}</span></button></li>;
}

function specLine(item: Item): string {
  const r = resolve(item), s = r.specs;
  return [s.kv && `${s.kv} KV`, s.stator, s.cells && cellRange(s.cells), s.series && `${s.series}S ${s.mah} mAh ${s.chem ?? ''}`.trim(), s.propIn && `${s.propIn}"`, s.blades && `${s.blades}-blade`, s.mounts && `${s.mounts.join(' / ')}${s.mounts[0] === 'whoop' ? '' : ' mm'}`, s.amps && item.category === 'stack' && `${s.amps} A`, s.video && VIDEO_NAME[s.video], s.link, s.includes?.length && `includes ${s.includes.join(', ')}`, r.weightG !== undefined && `${r.weightG} g`].filter(Boolean).join(' · ');
}

function Slot({ slot, label }: { slot: string; label: string }) {
  const Icon = ICON[slot] ?? Package;
  return <span className="bd-slot" role="cell"><Icon size={16} />{label}</span>;
}

function PartRow({ item, apply, onSwap, onOpen, lit, fresh }: { item: Item; apply: Apply; onSwap?: () => void; onOpen: () => void; lit: boolean; fresh: boolean }) {
  const r = resolve(item), [links, setLinks] = useState(false);
  const total = r.unitUsd !== undefined ? r.unitUsd * item.qty : undefined;
  return (
    <div className={`bd-row${item.owned ? ' is-owned' : ''}${lit ? ' is-lit' : ''}${fresh ? ' is-fresh' : ''}`} role="row">
      <Slot slot={item.category} label={SLOT_LABEL[item.category]} />
      <div className="bd-sel" role="cell">
        <button className="bd-thumb" onClick={onOpen} disabled={!item.part} aria-label={`About ${r.name}`}><PartArt part={drawable(item)} size={52} /></button>
        <div className="bd-what">
          <button className="bd-name-link" onClick={onOpen} disabled={!item.part}>{r.brand && <span>{r.brand} </span>}{r.name}</button>
          <small>{specLine(item)}</small>
          {item.note && <em>{item.note}</em>}
          {item.by !== 'you' && <i className="bd-by"><Bot size={11} /> {item.by}</i>}
        </div>
      </div>
      <div className="bd-rate-cell" role="cell"><RatingBadge part={item.part} /></div>
      <div className="bd-price" role="cell">
        <b>{total !== undefined ? money(total) : '—'}</b>
        <small>{item.owned ? 'Owned' : r.priceSource === 'seen' ? `${money(r.unitUsd!)} at ${item.price?.store ?? 'store'} · ${ago(item.price!.at)}` : r.priceSource === 'typical' ? `${item.qty > 1 ? `${item.qty} × ${money(r.unitUsd!)} · ` : ''}typical` : 'No price'}</small>
        <div className="lu-stepper bd-qty">
          <button onClick={() => item.qty > 1 && void apply([{ op: 'qty', slot: item.slot, qty: item.qty - 1 }])} disabled={item.qty <= 1} aria-label="Fewer">−</button>
          <input value={item.qty} readOnly aria-label="Quantity" />
          <button onClick={() => void apply([{ op: 'qty', slot: item.slot, qty: item.qty + 1 }])} aria-label="More">+</button>
        </div>
      </div>
      <div className="bd-actions" role="cell">
        <div className="bd-buy">
          <button className="lu-btn is-primary" onClick={() => setLinks(!links)} aria-expanded={links}>Buy <ChevronDown size={13} /></button>
          {links && <div className="bd-links" onMouseLeave={() => setLinks(false)}>{r.links.map(l => <a key={l.store + l.url} href={l.url} target="_blank" rel="noreferrer noopener">{l.store}<ExternalLink size={12} /></a>)}{r.maker && <a href={r.maker} target="_blank" rel="noreferrer noopener">{r.brand} site<ExternalLink size={12} /></a>}</div>}
        </div>
        {onSwap && <button className="lu-icon" onClick={onSwap} aria-label={`Swap the ${SLOT_LABEL[item.category]}`} title="Compare and swap"><ArrowLeftRight size={15} /></button>}
        <button className={`lu-icon${item.owned ? ' is-on' : ''}`} onClick={() => void apply([{ op: 'own', slot: item.slot, owned: !item.owned }])} aria-pressed={!!item.owned} aria-label="I already have this" title="I already have this"><PackageCheck size={15} /></button>
        <button className="lu-icon" onClick={() => void apply([{ op: 'remove', slot: item.slot }])} aria-label="Remove" title="Remove"><X size={15} /></button>
      </div>
    </div>
  );
}

function EmptyRow({ slot, label, note, optional, onPick, lit }: { slot: string; label: string; note?: string; optional?: boolean; onPick?: () => void; lit: boolean }) {
  return (
    <div className={`bd-row is-empty${lit ? ' is-lit' : ''}`} role="row">
      <Slot slot={slot} label={label} />
      <div className="bd-sel" role="cell">
        {note ? <small className="bd-note">{note}</small> : <button className={`lu-btn${optional ? '' : ' is-primary'}`} onClick={onPick}><Plus size={14} /> Choose {label === 'Goggles' ? '' : optional ? 'a ' : 'the '}{label === 'GPS' ? label : label.toLowerCase()}</button>}
        {!note && optional && <small className="bd-note">Optional</small>}
      </div>
    </div>
  );
}

// ---- Browsing parts ----------------------------------------------------------------------------------------------

/** The specs that matter for comparing parts of one kind. */
const COLUMNS: Record<string, [string, (p: Part) => string | number | undefined][]> = {
  frame: [['Prop size', p => `${p.specs.propIn}"`], ['Mount', p => p.specs.mounts?.join(' / ')], ['Type', p => p.specs.ducted ? 'Ducted' : 'Open']],
  motors: [['Stator', p => p.specs.stator], ['KV', p => p.specs.kv], ['Cells', p => p.specs.cells && cellRange(p.specs.cells)]],
  stack: [['Mount', p => p.specs.mounts?.join(' / ')], ['Cells', p => p.specs.cells && cellRange(p.specs.cells)], ['ESC', p => p.specs.amps && `${p.specs.amps} A`]],
  props: [['Size', p => `${p.specs.propIn}"`], ['Blades', p => p.specs.blades]],
  battery: [['Cells', p => `${p.specs.series}S`], ['Capacity', p => `${p.specs.mah} mAh`], ['Type', p => p.specs.chem]],
  receiver: [['Link', p => p.specs.link], ['Antennas', p => p.specs.diversity ? 2 : 1]],
  vtx: [['System', p => p.specs.video && VIDEO_NAME[p.specs.video]], ['Camera', p => p.specs.includes?.includes('camera') ? 'Included' : 'Separate']],
  camera: [['System', p => p.specs.video && VIDEO_NAME[p.specs.video]]],
  radio: [['Link', p => p.specs.link]], goggles: [['System', p => p.specs.video && VIDEO_NAME[p.specs.video]]],
};
type Sort = 'fit' | 'price' | 'price-desc' | 'rating' | 'name';

function PartList({ build, category, onAdd, onOpen, addLabel }: { build?: BuildDoc; category: Category; onAdd?: (part: Part) => void; onOpen: (id: string) => void; addLabel?: string }) {
  const ratings = useContext(Ratings).all;
  const [query, setQuery] = useState(''), [sort, setSort] = useState<Sort>(build ? 'fit' : 'price'), [compatible, setCompatible] = useState(false);
  const [brands, setBrands] = useState<string[]>([]), [maxPrice, setMaxPrice] = useState<number>(), [minStars, setMinStars] = useState(0);
  useEffect(() => { setBrands([]); setMaxPrice(undefined); setQuery(''); }, [category]);
  const all = PARTS.filter(p => p.category === category);
  const fits = useMemo(() => new Map(build ? all.map(p => [p.id, fitOf(build, p)] as const) : []), [build, category]); // eslint-disable-line react-hooks/exhaustive-deps
  const priceTop = Math.max(...all.map(p => p.priceUsd), 1);
  const current = build?.items.find(i => i.slot === category)?.part;
  const order = { fits: 0, warn: 1, fails: 2 };
  const shown = all.filter(p => (!query || `${p.brand} ${p.name} ${p.blurb}`.toLowerCase().includes(query.toLowerCase())) && (!brands.length || brands.includes(p.brand)) && (maxPrice === undefined || p.priceUsd <= maxPrice)
    && (!compatible || fits.get(p.id)?.fit !== 'fails') && (!minStars || (ratings[p.id]?.average ?? 0) >= minStars))
    .sort((x, y) => sort === 'price' ? x.priceUsd - y.priceUsd : sort === 'price-desc' ? y.priceUsd - x.priceUsd : sort === 'name' ? `${x.brand}${x.name}`.localeCompare(`${y.brand}${y.name}`)
      : sort === 'rating' ? (ratings[y.id]?.average ?? 0) - (ratings[x.id]?.average ?? 0) || (ratings[y.id]?.count ?? 0) - (ratings[x.id]?.count ?? 0)
      : (order[fits.get(x.id)?.fit ?? 'fits'] - order[fits.get(y.id)?.fit ?? 'fits']) || x.priceUsd - y.priceUsd);
  const cols = COLUMNS[category] ?? [];
  return (
    <div className="bd-browse">
      <aside className="bd-filters" aria-label="Filters">
        <label className="lu-search"><Search size={15} /><input placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} /></label>
        {build && <label className="bd-toggle"><input type="checkbox" checked={compatible} onChange={e => setCompatible(e.target.checked)} /> Compatible with my build</label>}
        <fieldset><legend>Price</legend><input type="range" min={0} max={priceTop} step={1} value={maxPrice ?? priceTop} onChange={e => setMaxPrice(Number(e.target.value) >= priceTop ? undefined : Number(e.target.value))} aria-label="Highest price" /><small>Up to {maxPrice === undefined ? 'any price' : money(maxPrice)}</small></fieldset>
        <fieldset><legend>Rating</legend><select value={minStars} onChange={e => setMinStars(Number(e.target.value))}><option value={0}>Any</option>{[4, 3, 2].map(n => <option key={n} value={n}>{n} stars and up</option>)}</select></fieldset>
        <fieldset><legend>Brand</legend>{[...new Set(all.map(p => p.brand))].sort().map(brand => <label key={brand} className="bd-toggle"><input type="checkbox" checked={brands.includes(brand)} onChange={() => setBrands(brands.includes(brand) ? brands.filter(x => x !== brand) : [...brands, brand])} /> {brand}</label>)}</fieldset>
      </aside>
      <div className="bd-results">
        <div className="bd-results-head"><span><ListFilter size={14} /> {shown.length} of {all.length} {SLOT_LABEL[category].toLowerCase()} parts</span>
          <label className="bd-field">Sort<select value={sort} onChange={e => setSort(e.target.value as Sort)}>{build && <option value="fit">Best fit</option>}<option value="price">Price: low to high</option><option value="price-desc">Price: high to low</option><option value="rating">Rating</option><option value="name">Name</option></select></label>
        </div>
        <ul className="bd-list">
          {shown.map(p => {
            const fit = fits.get(p.id), here = p.id === current;
            return (
              <li key={p.id} className={`bd-product${fit ? ` is-${fit.fit}` : ''}${here ? ' is-current' : ''}`}>
                <button className="bd-thumb" onClick={() => onOpen(p.id)} aria-label={`About ${p.name}`}><PartArt part={p} size={76} /></button>
                <div className="bd-product-main">
                  <button className="bd-name-link" onClick={() => onOpen(p.id)}><span>{p.brand} </span>{p.name}</button>
                  <RatingBadge part={p.id} />
                  <p>{p.blurb}</p>
                  {cols.length > 0 && <dl className="bd-specs">{cols.map(([label, get]) => <div key={label}><dt>{label}</dt><dd>{get(p) ?? '—'}</dd></div>)}{p.weightG !== undefined && <div><dt>Weight</dt><dd>{p.weightG} g</dd></div>}</dl>}
                  {fit?.problems.map(t => <em key={t}>{t}</em>)}
                </div>
                <div className="bd-product-side">
                  {fit && <i className={`bd-fit is-${fit.fit}`}>{fit.fit === 'fits' ? 'Compatible' : fit.fit === 'warn' ? 'Works, with a catch' : 'Not compatible'}</i>}
                  <b>{money(p.priceUsd)}{(p.qty ?? 1) > 1 && <small> each</small>}</b>
                  {fit && current && !here && <small>{fit.costDeltaUsd === 0 ? 'Same total' : `${fit.costDeltaUsd > 0 ? '+' : '−'}${money(Math.abs(fit.costDeltaUsd))} total`}{fit.weightDeltaG ? ` · ${fit.weightDeltaG > 0 ? '+' : '−'}${Math.abs(fit.weightDeltaG)} g` : ''}</small>}
                  {here ? <span className="bd-in-build"><Check size={14} /> In your build</span> : onAdd && <button className="lu-btn is-primary" onClick={() => onAdd(p)}>{addLabel ?? (current ? 'Swap in' : 'Add')}</button>}
                </div>
              </li>
            );
          })}
          {!shown.length && <li className="bd-none">Nothing matches these filters.</li>}
        </ul>
      </div>
    </div>
  );
}

function Browser({ build, category, onClose, onOpen, apply }: { build: BuildDoc; category: Category; onClose: () => void; onOpen: (id: string) => void; apply: (ops: BuildOp[]) => Promise<void> }) {
  const [mode, setMode] = useState<'catalog' | 'custom'>(category === 'other' && !PARTS.some(p => p.category === 'other') ? 'custom' : 'catalog');
  useEscape(onClose);
  const current = build.items.find(i => i.slot === category);
  return (
    <div className="lu-scrim" role="dialog" aria-modal aria-label={`Choose ${SLOT_LABEL[category]}`} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bd-panel">
        <header><h2>{(() => { const Icon = ICON[category] ?? Package; return <Icon size={20} />; })()}{current && category !== 'other' ? `Swap the ${SLOT_LABEL[category].toLowerCase()}` : `Choose ${category === 'other' ? 'an extra' : `the ${SLOT_LABEL[category].toLowerCase()}`}`}</h2>
          <div className="lu-segments" role="radiogroup"><button role="radio" aria-checked={mode === 'catalog'} onClick={() => setMode('catalog')}>Catalog</button><button role="radio" aria-checked={mode === 'custom'} onClick={() => setMode('custom')}>A part I found</button></div>
          <button className="lu-icon" onClick={onClose} aria-label="Close"><X size={17} /></button></header>
        {mode === 'catalog' ? <PartList build={build} category={category} onOpen={onOpen} onAdd={p => void apply([{ op: 'add', part: p.id }])} /> : <CustomForm category={category} onAdd={op => apply([op])} />}
      </div>
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
}

/** Browse the whole catalog, by kind of part, with or without a build. */
function Catalog({ build, apply }: { build?: Loaded; apply: Apply }) {
  const [category, setCategory] = useState<Category>('frame'), [detail, setDetail] = useState<string>();
  const add = async (p: Part) => {
    if (build) { await apply([{ op: 'add', part: p.id }]); toast(`Added ${p.brand} ${p.name} to ${build.name}`, 'ok'); }
    else { await createBuild('My build', [{ op: 'add', part: p.id }]); toast(`Started a build with ${p.brand} ${p.name}`, 'ok'); set({ buildTab: 'parts' }); }
  };
  return (
    <div className="bd-catalog">
      <nav className="bd-cats" aria-label="Kinds of part">
        {GROUPS.map(g => <div key={g.id}><small>{g.title}</small>{CATEGORY_ORDER.filter(c => groupOf(c) === g.id).map(c => { const Icon = ICON[c]; const n = PARTS.filter(p => p.category === c).length; return <button key={c} className={category === c ? 'is-on' : ''} onClick={() => setCategory(c)}><Icon size={16} /><span>{c === 'other' ? 'Extras' : SLOT_LABEL[c]}</span><small>{n}</small></button>; })}</div>)}
      </nav>
      <PartList key={category} build={build?.content} category={category} onOpen={setDetail} onAdd={p => void add(p)} addLabel={build ? undefined : 'Start a build with this'} />
      {detail && <Detail id={detail} build={build?.content} onClose={() => setDetail(undefined)} apply={async ops => { if (build) await apply(ops); else await createBuild('My build', ops); setDetail(undefined); }} />}
    </div>
  );
}

// ---- One part ----------------------------------------------------------------------------------------------------

function Detail({ id, build, onClose, apply }: { id: string; build?: BuildDoc; onClose: () => void; apply: (ops: BuildOp[]) => Promise<void> }) {
  const part = PART_BY_ID.get(id)!, ratings = useContext(Ratings);
  const [reviews, setReviews] = useState<RatingSummary & { reviews: { stars: number; review?: string; at: number; mine: boolean }[] }>();
  const [stars, setStars] = useState(0), [hover, setHover] = useState(0), [text, setText] = useState(''), [saving, setSaving] = useState(false);
  useEscape(onClose);
  const load = () => api('GET', `/ratings/${id}`).then(r => { setReviews(r); setStars(r.mine?.stars ?? 0); setText(r.mine?.review ?? ''); }, () => {});
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const fit = build ? fitOf(build, part) : undefined, inBuild = build?.items.some(i => i.part === id);
  const save = async () => { setSaving(true); try { await api('PUT', `/ratings/${id}`, { stars, review: text.trim() || undefined }); toast('Thanks for rating it.', 'ok'); ratings.reload(); await load(); } catch (e) { toast(e instanceof Error ? e.message : 'Could not save.', 'bad'); } finally { setSaving(false); } };
  const unrate = async () => { await api('DELETE', `/ratings/${id}`); ratings.reload(); await load(); };
  const s = part.specs, rows: [string, string | number | undefined][] = [
    ['Kind', SLOT_LABEL[part.category]], ...(COLUMNS[part.category] ?? []).map(([l, get]) => [l, get(part)] as [string, string | number | undefined]),
    ['Thrust', s.thrustG && `about ${s.thrustG} g per motor`], ['Peak current', part.category === 'motors' && s.amps ? `${s.amps} A` : undefined], ['Includes', s.includes?.join(', ')],
    ['Weight', part.weightG !== undefined && `${part.weightG} g${part.category === 'props' ? ' per set of four' : ''}`], ['Usually bought', (part.qty ?? 1) > 1 ? `${part.qty}` : undefined],
  ].filter((r): r is [string, string | number] => r[1] !== undefined && r[1] !== false && r[1] !== '');
  return (
    <div className="lu-scrim" role="dialog" aria-modal aria-label={part.name} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bd-panel bd-detail">
        <header><h2>{part.brand} {part.name}</h2><button className="lu-icon" onClick={onClose} aria-label="Close"><X size={17} /></button></header>
        <div className="bd-detail-body">
          <div className="bd-detail-left">
            <PartArt part={part} size={220} />
            <div className="bd-detail-buy">
              <b>{money(part.priceUsd)}{(part.qty ?? 1) > 1 && <small> each</small>}</b><small>Typical price, not live</small>
              {fit && !inBuild && <i className={`bd-fit is-${fit.fit}`}>{fit.fit === 'fits' ? 'Compatible with your build' : fit.fit === 'warn' ? 'Works, with a catch' : 'Not compatible with your build'}</i>}
              {fit?.problems.map(t => <em key={t}>{t}</em>)}
              {inBuild ? <span className="bd-in-build"><Check size={14} /> In your build</span> : <button className="lu-btn is-primary" onClick={() => void apply([{ op: 'add', part: id }])}><Plus size={14} /> {build ? (build.items.some(i => i.slot === part.category && part.category !== 'other') ? 'Swap into my build' : 'Add to my build') : 'Start a build with this'}</button>}
              <ul className="bd-stores">{[...storeLinks(part), ...(part.maker ? [{ store: `${part.brand} site`, url: part.maker }] : [])].map(l => <li key={l.store}><a href={l.url} target="_blank" rel="noreferrer noopener">{l.store}<ExternalLink size={12} /></a></li>)}</ul>
            </div>
          </div>
          <div className="bd-detail-right">
            <p className="bd-blurb">{part.blurb}</p>
            <h3>Specs</h3>
            <dl className="bd-spec-table">{rows.map(([l, v]) => <div key={l}><dt>{l}</dt><dd>{v}</dd></div>)}</dl>
            <h3>Ratings</h3>
            <div className="bd-ratings">
              <div className="bd-score"><b>{reviews?.count ? reviews.average.toFixed(1) : '—'}</b><Stars value={reviews?.average ?? 0} size={16} /><small>{reviews?.count ? `${reviews.count} rating${reviews.count > 1 ? 's' : ''}` : 'No ratings yet'}</small></div>
              <div className="bd-hist">{[5, 4, 3, 2, 1].map(n => { const c = reviews?.histogram[n - 1] ?? 0; return <div key={n}><span>{n}</span><i><b style={{ width: `${reviews?.count ? c / reviews.count * 100 : 0}%` }} /></i><small>{c}</small></div>; })}</div>
            </div>
            <div className="bd-rate">
              <span>{reviews?.mine ? 'Your rating' : 'Flown it? Rate it'}</span>
              <div className="bd-rate-stars" onMouseLeave={() => setHover(0)} role="radiogroup" aria-label="Your rating">
                {[1, 2, 3, 4, 5].map(n => <button key={n} role="radio" aria-checked={stars === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={(hover || stars) >= n ? 'is-on' : ''} onMouseEnter={() => setHover(n)} onClick={() => setStars(n)}><Star size={22} /></button>)}
              </div>
              <textarea rows={2} maxLength={600} value={text} onChange={e => setText(e.target.value)} placeholder="What was it like? Durability, how it flies, anything to watch out for." aria-label="Your review" />
              <div className="lu-row"><button className="lu-btn is-primary" disabled={!stars || saving} onClick={save}>{reviews?.mine ? 'Update' : 'Post rating'}</button>{reviews?.mine && <button className="lu-link" onClick={unrate}>Remove my rating</button>}</div>
            </div>
            {reviews?.reviews.filter(r => r.review).map((r, i) => <blockquote key={i} className="bd-review"><Stars value={r.stars} /><p>{r.review}</p><small>{r.mine ? 'You' : 'A pilot'} · {new Date(r.at).toLocaleDateString()}</small></blockquote>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomForm({ category, onAdd }: { category: Category; onAdd: (op: BuildOp) => void }) {
  const [f, setF] = useState({ category, name: '', brand: '', price: '', url: '', weight: '', store: '' });
  const field = (key: keyof typeof f) => ({ value: f[key], onChange: (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value }) });
  const valid = f.name.trim() && (!f.url || /^https:\/\//.test(f.url));
  return (
    <form className="bd-custom" onSubmit={e => { e.preventDefault(); if (!valid) return; onAdd({ op: 'custom', category: f.category, name: f.name.trim(), brand: f.brand.trim() || undefined, priceUsd: f.price ? Number(f.price) : undefined, url: f.url || undefined, store: f.store.trim() || (f.url ? new URL(f.url).hostname.replace(/^www\./, '') : undefined), weightG: f.weight ? Number(f.weight) : undefined }); }}>
      <label>Kind of part<select {...field('category')} onChange={e => setF({ ...f, category: e.target.value as Category })}>{CATEGORY_ORDER.map(c => <option key={c} value={c}>{SLOT_LABEL[c]}</option>)}</select></label>
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
        const hero = ['frame', 'motors', 'vtx', 'battery'].map(slot => build.items.find(i => i.slot === slot)).filter(Boolean) as Item[];
        return (
          <article key={p.id} className="lu-card bd-proven-card">
            <div className="bd-proven-art" aria-hidden>{hero.map(i => <PartArt key={i.slot} part={drawable(i)} size={60} />)}</div>
            <header><h3>{p.name}</h3><b>{money(a.costUsd)}</b></header>
            <nav className="bd-tags"><span>{STYLE_LABEL[p.style]}</span><span>{p.propIn}"</span><span>{VIDEO_NAME[p.video]}</span>{a.weightG && <span>{a.weightG} g</span>}{a.flightMinutes && <span>{a.flightMinutes[0]}–{a.flightMinutes[1]} min</span>}</nav>
            <p>{p.summary}</p>
            {expanded && <>
              <p className="lu-hint">{p.why}</p>
              <ul className="bd-proven-parts">{build.items.map(i => { const r = resolve(i), Icon = ICON[i.category] ?? Package; return <li key={i.slot}><span><Icon size={13} /> {SLOT_LABEL[i.category]}</span><a href={r.links[0].url} target="_blank" rel="noreferrer noopener">{r.brand} {r.name}<ExternalLink size={11} /></a><b>{i.qty > 1 ? `${i.qty} × ` : ''}{money(r.unitUsd!)}</b></li>; })}</ul>
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
