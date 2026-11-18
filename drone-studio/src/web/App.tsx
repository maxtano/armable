import { useEffect, useRef } from 'react';
import { Activity, AudioLines, Bot, Cable, ChartSpline, CloudUpload, Eye, FileUp, Hammer, History as HistoryIcon, LogOut, Moon, Navigation, Plug, Radio, SlidersHorizontal, Sparkles, Square, Sun, Usb, X } from 'lucide-react';
import { useState } from 'react';
import { Build, SharedBuild } from './Build';
import { boot, FeedbackButton, FeedbackDialog, HelpfulPrompt, SaveDialog } from './Growth';
import { History } from './History';
import { OsdEditor } from './OsdEditor';
import { RadioFlash } from './RadioFlash';
import type { PartId } from '../device/types';
import { Connect, Consent, ModeSwitch } from './Connect';
import { answerPrompt, connectDemo, connectUsb, disconnect, go, select, signOut, stopAll } from './controller';
import { Diagram } from './Diagram';
import { Coil } from './Instruments';
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

const VIEWS: [View, typeof Activity, string][] = [['drone', Navigation, 'Drone'], ['build', Hammer, 'Build'], ['signals', Activity, 'Signals'], ['flights', ChartSpline, 'Flights'], ['show', Sparkles, 'Show'], ['sound', AudioLines, 'Sound'], ['settings', SlidersHorizontal, 'Settings'], ['history', HistoryIcon, 'History']];
const theme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
function toggleTheme() { const next = theme() === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = next; try { localStorage.setItem('lucidity.appearance.v1', next); } catch { /* private mode */ } }

function AssistantChip() {
  const me = useStore(s => s.me), activity = useStore(s => s.activity), open = useStore(s => s.view === 'connect');
  const last = [...activity].reverse().find(a => a.who !== 'you');
  const active = !!last && Date.now() - last.at < 4000;
  const names = me?.assistants?.map(a => a.name) ?? [];
  return (
    <button className={`lu-assistant mode-${me?.mode ?? 'propose'}${active ? ' is-active' : ''}${open ? ' is-on' : ''}`} onClick={() => go('connect')} aria-label={`Assistant: ${names.join(', ') || 'none connected'}, ${me?.mode ?? 'propose'}`}>
      <span className="lu-assistant-ring"><Bot size={18} /></span>
      <span className="lu-rail-label">{names[0] ?? 'Assistant'}</span>
    </button>
  );
}

function TopBar() {
  const snap = useStore(s => s.snap), busy = useStore(s => s.busy), part = useStore(s => s.part), follow = useStore(s => s.follow), view = useStore(s => s.view);
  const pending = useStore(s => s.proposals.filter(p => p.status === 'awaiting_approval'));
  const connected = snap.status === 'connected', id = snap.identity;
  const parts = connected ? CHIP_PARTS : [];
  return (
    <header className="lu-top">
      <div className={`lu-status is-${snap.status}${snap.state?.armed ? ' is-armed' : ''}`}>
        <i />{connected ? <><b>{id?.craftName ?? id?.firmware}</b><span>{id?.firmware} {id?.version}</span></> : snap.status === 'reconnecting' ? <b>Restarting…</b> : snap.status === 'connecting' ? <b>Connecting…</b> : <b>No drone</b>}
      </div>
      {connected && view === 'drone' && <nav className="lu-chips is-quiet" aria-label="More parts">{parts.map(p => <button key={p} className={part === p ? 'is-on' : ''} onClick={() => select(p as PartId)}>{PART_NAME[p]}</button>)}</nav>}
      <div className="lu-top-end">
        {pending.length > 0 && <button className="lu-badge" onClick={() => go('drone', pending[0].part as PartId)}>{pending.length} waiting</button>}
        <button className={`lu-icon${follow ? ' is-on' : ''}`} onClick={() => set({ follow: !follow })} aria-pressed={follow} aria-label="Follow the assistant" title="Follow the assistant"><Eye size={17} /></button>
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
      <nav className="lu-rail" aria-label="Views">
        <button className="lu-logo" onClick={() => go('drone')} aria-label="Lucidity"><img src="/favicon.svg" alt="" width="24" height="24" /></button>
        {VIEWS.map(([id, Icon, label]) => <button key={id} className={view === id ? 'is-on' : ''} onClick={() => go(id)} aria-current={view === id ? 'page' : undefined}><Icon size={19} /><span className="lu-rail-label">{label}</span></button>)}
        <span className="lu-rail-gap" />
        {me.guest && <button className="lu-save" onClick={() => set({ dialog: 'save' })} title="Save your bench"><CloudUpload size={18} /><span className="lu-rail-label">Save</span></button>}
        <FeedbackButton />
        <AssistantChip />
        <button onClick={toggleTheme} aria-label="Light or dark"><Sun size={17} className="only-dark" /><Moon size={17} className="only-light" /></button>
        <button onClick={signOut} aria-label="Sign out" title={me.email}><LogOut size={17} /></button>
      </nav>
      <main className="lu-main">
        <TopBar />
        {me.offline ? <div className="lu-offline" role="status">Offline. The drone tools still work; your changes sync when you are back online.</div>
          : !live && <div className="lu-offline" role="status">Reconnecting to Lucidity…</div>}
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
