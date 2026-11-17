import { useState } from 'react';
import { ArrowRight, ChevronDown, Hand, Square, X } from 'lucide-react';
import type { Condition, PartId, TestSpec } from '../device/types';
import { Conditions, SettingControl } from './controls';
import { applyChanges, approve, decline, go, runTest, select, stopAll } from './controller';
import { BUTTON, featured, format, PART_NAME, testsFor } from './parts';
import { useStore, type ProposalCard } from './store';

/** A change or test someone asked for, shown where it applies, with the before and after and one button. */
export function Proposal({ card }: { card: ProposalCard }) {
  const [confirmed, setConfirmed] = useState<Condition[]>([]);
  const busy = useStore(s => !!s.busy), settings = useStore(s => s.settings);
  const ready = card.needs.every(n => confirmed.includes(n as Condition));
  const label = (id: string, value: unknown) => { const s = settings.find(x => x.id === id); return s?.options?.find(o => String(o.value).toLowerCase() === String(value).toLowerCase())?.label ?? format(value, s?.unit); };
  return (
    <section className="lu-proposal" aria-label={`Proposal from ${card.by}`} data-proposal={card.id}>
      <header><Hand size={14} /><b>{card.by}</b> proposes</header>
      {card.changes?.map(c => (
        <div className="lu-diff" key={c.id}>
          <span className="lu-diff-name">{c.title ?? c.id}</span>
          <span className="lu-from">{label(c.id, c.before)}</span><ArrowRight size={14} aria-hidden /><span className="lu-to">{label(c.id, c.value)}</span>
        </div>
      ))}
      {card.test && <div className="lu-diff"><span className="lu-diff-name">{card.test.name}</span>{card.test.args && <span className="lu-to">{Object.entries(card.test.args).map(([k, v]) => `${k} ${v}`).join(' · ')}</span>}</div>}
      {card.reason && <p className="lu-reason">“{card.reason}”</p>}
      <Conditions needs={card.needs} value={confirmed} onChange={setConfirmed} />
      <div className="lu-row">
        <button className="lu-btn is-primary" disabled={busy || !ready} onClick={() => approve(card, confirmed)}>{card.level === 3 ? 'Start' : 'Approve'}</button>
        <button className="lu-btn" disabled={busy} onClick={() => decline(card)}>Decline</button>
      </div>
    </section>
  );
}

function TestButton({ spec, args, primary, label }: { spec: TestSpec; args?: Record<string, unknown>; primary?: boolean; label?: string }) {
  const [open, setOpen] = useState(false), [confirmed, setConfirmed] = useState<Condition[]>([]);
  const busy = useStore(s => !!s.busy);
  const run = async () => { setOpen(false); await runTest(spec, args, confirmed); setConfirmed([]); };
  if (!spec.needs.length) return <button className={`lu-btn${primary ? ' is-primary' : ''}`} disabled={busy} onClick={run} title={spec.proves}>{label ?? BUTTON[spec.id] ?? spec.name}</button>;
  return (
    <>
      <button className={`lu-btn${primary ? ' is-primary' : ''}${open ? ' is-open' : ''}`} disabled={busy} onClick={() => setOpen(!open)} aria-expanded={open} title={spec.proves}>{label ?? BUTTON[spec.id] ?? spec.name}</button>
      {open && (
        <div className="lu-confirm">
          <Conditions needs={spec.needs} value={confirmed} onChange={setConfirmed} />
          <button className="lu-btn is-primary" disabled={busy || !spec.needs.every(n => confirmed.includes(n))} onClick={run}>{spec.level === 3 ? 'Start' : 'Go'}</button>
        </div>
      )}
    </>
  );
}

function Reverse({ motor }: { motor: number }) {
  const [open, setOpen] = useState(false), [confirmed, setConfirmed] = useState<Condition[]>([]);
  const busy = useStore(s => !!s.busy);
  const setting = useStore(s => s.settings.find(x => x.id === `esc.${motor}.direction`));
  const read = useStore(s => s.snap.tests.find(t => t.id === 'esc.read'));
  if (!setting) return read ? <TestButton spec={read} label="Read ESCs" /> : null;
  if (setting.readOnly || (setting.value !== 'normal' && setting.value !== 'reversed')) return null;
  const next = setting.value === 'normal' ? 'reversed' : 'normal';
  const needs: Condition[] = ['propsRemoved', 'directUsb'];
  return (
    <>
      <button className={`lu-btn${open ? ' is-open' : ''}`} disabled={busy} onClick={() => setOpen(!open)} aria-expanded={open}>Reverse</button>
      {open && (
        <div className="lu-confirm">
          <div className="lu-diff"><span className="lu-diff-name">Direction</span><span className="lu-from">{String(setting.value)}</span><ArrowRight size={14} aria-hidden /><span className="lu-to">{next}</span></div>
          <Conditions needs={needs} value={confirmed} onChange={setConfirmed} />
          <button className="lu-btn is-primary" disabled={busy || !needs.every(n => confirmed.includes(n))} onClick={async () => { setOpen(false); await applyChanges([{ id: setting.id, value: next, expected: setting.value }], confirmed); setConfirmed([]); }}>Reverse it</button>
        </div>
      )}
    </>
  );
}

function Readings({ part, motor }: { part: PartId; motor?: number }) {
  const snap = useStore(s => s.snap), st = snap.state, settings = useStore(s => s.settings);
  const rows: [string, string][] = [];
  if (part === 'battery') { const b = st?.battery; rows.push(['Voltage', format(b && b.voltage >= 2 ? Number(b.voltage.toFixed(2)) : undefined, 'V')], ['Current', format(b?.current, 'A')], ['Left', format(b?.remaining, '%')]); }
  else if (part === 'gps') rows.push(['Satellites', format(st?.gps?.sats)], ['Fix', st?.gps ? (st.gps.fix >= 3 ? '3D' : 'None') : '—'], ['Accuracy', format(st?.gps?.hdop)]);
  else if (part === 'receiver') rows.push(['Channels', format(st?.rc?.channels.length || undefined)], ['Signal', format(st?.rc?.rssi, '%')], ['Throttle', format(st?.rc?.channels[2], 'µs')]);
  else if (part === 'fc') rows.push(['Roll', format(st?.attitude?.roll, '°')], ['Pitch', format(st?.attitude?.pitch, '°')], ['Mode', st?.mode ?? '—']);
  else if (part === 'motors' && motor) { const m = snap.airframe?.motors.find(x => x.number === motor), esc = snap.escs.find(e => e.index === motor); rows.push(['Turns', m?.spin === 'cw' ? '↻ CW' : m?.spin === 'ccw' ? '↺ CCW' : 'Unknown'], ['Output', format(st?.motors?.outputs[motor - 1], 'µs')], ['ESC', esc ? `${esc.firmware} ${esc.version ?? ''}`.trim() : 'Not read']); }
  else if (part === 'link') rows.push(['Port', snap.label ?? '—'], ['Link', st?.linkOk ? 'Live' : 'Silent'], ['Load', format(st?.cpuLoad, '%')]);
  else if (part === 'vtx') {
    const ch = settings.find(x => x.id === 'bf.vtx_channel'), label = ch?.options?.find(o => String(o.value) === String(ch.value))?.label;
    const power = settings.find(x => x.id === 'bf.vtx_power'), plabel = power?.options?.find(o => String(o.value) === String(power.value))?.label;
    rows.push(['Frequency', label?.match(/(\d{4}) MHz/)?.[0] ?? format(settings.find(x => x.id === 'bf.vtx_freq')?.value, 'MHz')], ['Power', plabel ?? format(power?.value)], ['Table', String(settings.find(x => x.id === 'bf.vtxtable')?.value ?? '—')]);
  }
  else if (part === 'osd') { const n = settings.filter(x => x.id.startsWith('bf.osd_') && x.id.endsWith('_pos')); rows.push(['Elements', String(n.length)], ['Shown', String(n.filter(x => (Number(x.value) & 0x800) !== 0).length)], ['System', String(settings.find(x => x.id === 'bf.vcd_video_system')?.value ?? '—')]); }
  else if (part === 'safety') rows.push(['Armed', st?.armed ? 'Yes' : 'No'], ['Blocks', String(st?.armingBlocks.length ?? 0)]);
  if (!rows.length) return null;
  return <dl className="lu-readings">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export function PartPanel() {
  const part = useStore(s => s.part), motor = useStore(s => s.motor), snap = useStore(s => s.snap), settings = useStore(s => s.settings);
  const proposals = useStore(s => s.proposals), busy = useStore(s => s.busy), progress = useStore(s => s.progress);
  const [more, setMore] = useState(false);
  if (!part) return null;
  const stack = snap.identity?.stack;
  const mine = proposals.filter(p => p.status === 'awaiting_approval' && (p.part === part || p.changes?.some(c => settings.find(s => s.id === c.id)?.part === part)) && (!motor || !p.changes?.every(c => c.id.startsWith('esc.')) || p.changes.some(c => c.id.startsWith(`esc.${motor}.`))));
  const tests = testsFor(part, snap.tests);
  const spin = tests.find(t => t.id === 'motor.spin');
  const main = part === 'motors' ? tests.filter(t => t.id !== 'motor.spin' && t.id !== 'esc.read').slice(0, 0) : tests.slice(0, 3);
  const rest = part === 'motors' ? tests.filter(t => t.id !== 'motor.spin') : tests.slice(3);
  const escSettings = part === 'motors' && motor ? settings.filter(s => s.id.startsWith(`esc.${motor}.`)) : [];
  // OSD positions are edited on the screen picture, not as numbers.
  const key = featured(part, stack, settings).filter(s => !(part === 'osd' && s.id.endsWith('_pos')));
  const count = settings.filter(s => s.part === part).length;
  const blocks = snap.state?.armingBlocks ?? [];
  return (
    <aside className="lu-panel" aria-label={PART_NAME[part]}>
      <header className="lu-panel-head">
        <h2>{part === 'motors' && motor ? `Motor ${motor}` : PART_NAME[part]}</h2>
        <button className="lu-icon" onClick={() => select(undefined)} aria-label="Close"><X size={18} /></button>
      </header>
      <div className="lu-panel-body">
        {mine.map(card => <Proposal key={card.id} card={card} />)}
        <Readings part={part} motor={motor} />
        {part === 'safety' && blocks.length > 0 && <ul className="lu-blocks">{blocks.map(b => <li key={b}>{b}</li>)}</ul>}
        {snap.status === 'connected' && (
          <div className="lu-actions">
            {part === 'motors' && motor && spin && <TestButton spec={spin} args={{ motor }} primary />}
            {part === 'motors' && motor && <Reverse motor={motor} />}
            {part === 'motors' && <button className="lu-btn is-stop" onClick={stopAll}><Square size={13} fill="currentColor" /> Stop</button>}
            {main.map((t, i) => <TestButton key={t.id} spec={t} primary={i === 0} />)}
          </div>
        )}
        {busy && <div className="lu-progress" role="status"><span>{progress?.label ?? busy}</span>{progress?.total ? <progress value={progress.done ?? 0} max={progress.total} /> : <i />}</div>}
        {part === 'motors' && !motor && <p className="lu-hint">Tap a motor</p>}
        {escSettings.length > 0 && <div className="lu-settings">{escSettings.map(s => <SettingControl key={s.id} setting={s} />)}</div>}
        {key.length > 0 && <div className="lu-settings">{key.map(s => <SettingControl key={s.id} setting={s} />)}</div>}
        {snap.status === 'connected' && snap.settingsLoaded !== 'complete' && !key.length && <p className="lu-hint">{snap.settingsLoaded === 'loading' ? 'Reading settings…' : 'Settings not read'}</p>}
        {rest.length > 0 && (
          <div className="lu-more">
            <button className="lu-link" onClick={() => setMore(!more)} aria-expanded={more}>More <ChevronDown size={14} className={more ? 'is-up' : ''} /></button>
            {more && <div className="lu-actions">{rest.map(t => <TestButton key={t.id} spec={t} />)}</div>}
          </div>
        )}
        {count > 0 && <button className="lu-link lu-all" onClick={() => go('settings', part)}>All {count} settings <ArrowRight size={14} /></button>}
      </div>
    </aside>
  );
}
