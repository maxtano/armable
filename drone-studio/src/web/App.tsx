import { useEffect, useRef } from 'react';
import { Activity, Bot, Cable, ChevronDown, CloudUpload, Eye, FileUp, Hammer, LogOut, Menu as MenuIcon, MessageSquarePlus, Moon, Navigation, Plug, Radio, SlidersHorizontal, Sparkles, Square, Sun, Usb, X } from 'lucide-react';
import { useState } from 'react';
import { Build, SharedBuild } from './Build';
import { boot, FeedbackDialog, HelpfulPrompt, SaveDialog } from './Growth';
import { History } from './History';
import { OsdEditor } from './OsdEditor';
import { RadioFlash } from './RadioFlash';
import type { PartId } from '../device/types';
import { Connect, Consent, ModeSwitch } from './Connect';
import { answerPrompt, connectDemo, connectUsb, disconnect, go, select, signOut, stopAll } from './controller';
import { Diagram } from './Diagram';
import { Coil, Lamp } from './Instruments';
import { Flights } from './Flights';
import { Landing } from './Landing';
import { PartPanel, Proposal } from './PartPanel';
import { CHIP_PARTS, PART_NAME } from './parts';
import { SettingsView } from './SettingsView';
import { Show } from './Show';
import { Signals } from './Signals';
import { Sound } from './Sound';
import { set, useStore, type View } from './store';
import { Timeline } from './Timeline';

/** Four places, no more: the drone, building one, shows, and a menu for everything about you and your assistant. */
type Section = 'bench' | 'build' | 'create';
const SECTIONS: [Section, typeof Activity, string, View][] = [['bench', Navigation, 'Drone', 'drone'], ['build', Hammer, 'Build', 'build'], ['create', Sparkles, 'Shows', 'show']];
const PAGES: Record<Section, [View, string][]> = {
  bench: [['drone', 'Drone'], ['signals', 'Signals'], ['flights', 'Flights'], ['settings', 'Settings'], ['history', 'History']],
  build: [],
  create: [['show', 'Show'], ['sound', 'Sound']],
};
const sectionOf = (view: View): Section | undefined => view === 'build' ? 'build' : view === 'show' || view === 'sound' ? 'create' : view === 'connect' ? undefined : 'bench';
const theme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
function toggleTheme() { const next = theme() === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = next; try { localStorage.setItem('armable.appearance.v1', next); } catch { /* private mode */ } }

/** A small popover that closes when you click elsewhere or press Escape. */
function usePopover() {
  const [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', away); addEventListener('keydown', key);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', key); };
  }, [open]);
  return { open, setOpen, ref };
}

function Rail() {
  const view = useStore(s => s.view), me = useStore(s => s.me)!, pending = useStore(s => s.proposals.filter(p => p.status === 'awaiting_approval'));
  const current = sectionOf(view);
  return (
    <nav className="lu-rail" aria-label="Sections">
      <img className="lu-logo" src="/favicon.svg" alt="Armable" width="26" height="26" />
      {SECTIONS.map(([id, Icon, label, home]) => (
        <button key={id} data-section={id} data-label={label} aria-label={label} className={current === id ? 'is-on' : ''} aria-current={current === id ? 'page' : undefined}
          onClick={() => id === 'bench' && pending.length ? go('drone', pending[0].part as PartId) : go(current === id ? view : home)}>
          <Icon size={20} />
          {id === 'bench' && pending.length > 0 && <i className="lu-count" aria-label={`${pending.length} waiting for you`}>{pending.length}</i>}
        </button>
      ))}
      <span className="lu-rail-gap" />
      <Menu guest={!!me.guest} email={me.email} />
    </nav>
  );
}

function Menu({ guest, email }: { guest: boolean; email?: string }) {
  const { open, setOpen, ref } = usePopover();
  const me = useStore(s => s.me), activity = useStore(s => s.activity), follow = useStore(s => s.follow), view = useStore(s => s.view);
  const names = me?.assistants?.map(a => a.name) ?? [];
  const last = [...activity].reverse().find(a => a.who !== 'you'), active = !!last && Date.now() - last.at < 4000;
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <div className="lu-menu-wrap" ref={ref}>
      <button className={`lu-menu-button${open || view === 'connect' ? ' is-on' : ''}${active ? ' is-active' : ''}`} data-label="Menu" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MenuIcon size={20} />
        {names.length > 0 && <Lamp tone="ok" />}
        {guest && <i className="lu-dot-signal" aria-hidden />}
      </button>
      {open && (
        <div className="lu-menu" role="menu">
          <button role="menuitem" onClick={pick(() => go('connect'))}><Bot size={17} /><span><b>Your assistant</b><small>{names.length ? `${names.join(', ')} connected` : 'Not connected yet'}</small></span></button>
          <label className="lu-menu-switch"><Eye size={17} /><span><b>Follow the assistant</b><small>Show what it’s looking at</small></span><input type="checkbox" checked={follow} onChange={() => set({ follow: !follow })} /></label>
          <hr />
          {guest && <button role="menuitem" className="is-signal" onClick={pick(() => set({ dialog: 'save' }))}><CloudUpload size={17} /><span><b>Save your bench</b><small>Keep it, from any browser</small></span></button>}
          <button role="menuitem" onClick={pick(() => set({ dialog: 'feedback' }))}><MessageSquarePlus size={17} /><span><b>Send feedback</b></span></button>
          <button role="menuitem" onClick={pick(toggleTheme)}><Moon size={17} className="only-light" /><Sun size={17} className="only-dark" /><span><b className="only-light">Dark mode</b><b className="only-dark">Light mode</b></span></button>
          <button role="menuitem" onClick={pick(() => void signOut())}><LogOut size={17} /><span><b>Sign out</b>{email && <small>{email}</small>}</span></button>
        </div>
      )}
    </div>
  );
}

/** The other parts of the drone, the ones the drawing does not show. */
function PartsMenu() {
  const { open, setOpen, ref } = usePopover();
  const part = useStore(s => s.part);
  return (
    <div className="lu-menu-wrap" ref={ref}>
      <button className={`lu-btn${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}><SlidersHorizontal size={14} /> Parts <ChevronDown size={13} /></button>
      {open && <div className="lu-menu is-down" role="menu">{CHIP_PARTS.map(p => <button key={p} role="menuitem" className={part === p ? 'is-current' : ''} onClick={() => { setOpen(false); go('drone', p as PartId); }}><span><b>{PART_NAME[p]}</b></span></button>)}</div>}
    </div>
  );
}

function TopBar() {
  const snap = useStore(s => s.snap), busy = useStore(s => s.busy), view = useStore(s => s.view);
  const connected = snap.status === 'connected', id = snap.identity, section = sectionOf(view);
  const pages = section ? PAGES[section] : [];
  return (
    <header className="lu-top">
      <div className={`lu-status is-${snap.status}${snap.state?.armed ? ' is-armed' : ''}`}>
        <i />{connected ? <><b>{id?.craftName ?? id?.firmware}</b><span>{id?.firmware} {id?.version}</span></> : snap.status === 'reconnecting' ? <b>Restarting…</b> : snap.status === 'connecting' ? <b>Connecting…</b> : <b>No drone</b>}
      </div>
      {pages.length > 1 && <nav className="lu-tabs" aria-label="Pages">{pages.map(([v, label]) => <button key={v} data-view={v} className={view === v ? 'is-on' : ''} aria-current={view === v ? 'page' : undefined} onClick={() => go(v)}>{label}</button>)}</nav>}
      <div className="lu-top-end">
        {connected && section === 'bench' && <PartsMenu />}
        {connected && <button className="lu-btn is-stop" onClick={stopAll}><Square size={12} fill="currentColor" /> Stop</button>}
        {snap.status === 'idle' ? <button className="lu-btn is-primary" disabled={!!busy} onClick={connectUsb}><Usb size={15} /> Connect</button> : <button className="lu-btn" onClick={disconnect}><Plug size={14} /> Disconnect</button>}
      </div>
    </header>
  );
}

function DroneView() {
  const snap = useStore(s => s.snap), busy = useStore(s => s.busy), progress = useStore(s => s.progress), part = useStore(s => s.part);
  const orphans = useStore(s => s.proposals.filter(p => p.status === 'awaiting_approval' && !p.part));
  const hasOsd = useStore(s => s.settings.some(x => x.id.startsWith('bf.osd_') && x.id.endsWith('_pos')));
  const [radio, setRadio] = useState(false);
  return (
    <div className={`lu-drone${part ? ' has-panel' : ''}`}>
      <div className="lu-stage" onClick={event => { if (event.target === event.currentTarget) select(undefined); }}>
        {part === 'osd' && hasOsd ? <OsdEditor /> : <Diagram />}
        {radio && <RadioFlash onClose={() => setRadio(false)} />}
        {snap.status === 'idle' && (
          <div className="lu-idle">
            <Coil className="lu-idle-coil" width={150} height={38} />
            <h1>Plug in your drone</h1>
            <button className="lu-btn is-primary is-big" disabled={!!busy} onClick={connectUsb}><Cable size={18} /> Connect over USB</button>
            <div className="lu-row"><span>No drone handy?</span><button className="lu-link" data-demo="betaflight" onClick={() => connectDemo('betaflight')}>Try the demo drone</button><span>· it won’t arm. Find out why.</span><button className="lu-link" data-demo="ardupilot" onClick={() => connectDemo('ardupilot')}>ArduPilot demo</button></div>
            <button className="lu-link" onClick={() => setRadio(true)}><Radio size={14} /> Flash a receiver or radio over USB</button>
            <button className="lu-build-cta" onClick={() => go('build')}><Hammer size={18} /><span><b>Don’t have a drone? Build one.</b><small>Pick parts that work together, with prices and links.</small></span></button>
          </div>
        )}
        {snap.status !== 'idle' && busy && !part && <div className="lu-progress is-floating" role="status"><span>{progress?.label ?? busy}</span>{progress?.total ? <progress value={progress.done ?? 0} max={progress.total} /> : <i />}</div>}
        {orphans.length > 0 && <div className="lu-orphans">{orphans.map(card => <Proposal key={card.id} card={card} />)}</div>}
      </div>
      <PartPanel />
    </div>
  );
}

function Overlays() {
  const toast = useStore(s => s.toast), prompt = useStore(s => s.prompt), reference = useStore(s => s.reference);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => set(s => (s.toast === toast ? { toast: undefined } : {})), 5200); return () => clearTimeout(t); }, [toast]);
  return (
    <>
      {toast && <div className={`lu-toast is-${toast.tone}`} role="status">{toast.text}</div>}
      <SaveDialog />
      <FeedbackDialog />
      <HelpfulPrompt />
      {reference && (
        <aside className="lu-reference" aria-label="Guide">
          <button className="lu-icon" onClick={() => set({ reference: undefined })} aria-label="Close"><X size={16} /></button>
          <small>{reference.kind === 'video' ? 'Video' : reference.kind === 'tool' ? 'Tool' : 'Guide'}</small><b>{reference.title}</b>
          <a className="lu-btn is-primary" href={reference.url} target="_blank" rel="noreferrer noopener">Open</a>
        </aside>
      )}
      {prompt && (
        <div className="lu-scrim" role="dialog" aria-modal aria-label={prompt.request.label}>
          <div className="lu-dialog">
            <h2>{prompt.request.label}</h2>
            {prompt.request.kind === 'file' ? <><input ref={file} type="file" hidden accept={prompt.request.accept} onChange={e => answerPrompt(e.target.files?.[0])} /><button className="lu-btn is-primary is-big" onClick={() => file.current?.click()}><FileUp size={17} /> Choose file</button></>
              : <button className="lu-btn is-primary is-big" onClick={() => answerPrompt()}><Usb size={17} /> {prompt.request.kind === 'step' ? 'Done' : 'Choose device'}</button>}
            <button className="lu-link" onClick={() => answerPrompt('cancel')}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

export function App() {
  const me = useStore(s => s.me), view = useStore(s => s.view), live = useStore(s => s.live);
  const consent = new URLSearchParams(location.search).get('consent');
  const shared = location.pathname.match(/^\/b\/([\w-]{4,40})\/?$/)?.[1];
  useEffect(() => { if (!shared) void boot(); }, [shared]);
  if (shared) return <><SharedBuild share={shared} /><Overlays /></>;
  if (!me) return <div className="lu-boot" />;
  if (!me.signedIn) return <Landing onSignedIn={() => void boot()} google={me.google} />;
  if (consent) return <><Consent id={consent} /><Overlays /></>;
  return (
    <div className="lu">
      <Rail />
      <main className="lu-main">
        <TopBar />
        {me.offline ? <div className="lu-offline" role="status">Offline. The drone tools still work; your changes sync when you are back online.</div>
          : !live && <div className="lu-offline" role="status">Reconnecting to Armable…</div>}
        <div className="lu-view">
          {view === 'drone' && <DroneView />}
          {view === 'build' && <Build />}
          {view === 'signals' && <Signals />}
          {view === 'flights' && <Flights />}
          {view === 'show' && <Show />}
          {view === 'sound' && <Sound />}
          {view === 'settings' && <SettingsView />}
          {view === 'history' && <History />}
          {view === 'connect' && <><div className="lu-mode-bar"><ModeSwitch /></div><Connect /></>}
        </div>
        {view !== 'show' && view !== 'build' && <Timeline />}
      </main>
      <Overlays />
    </div>
  );
}
