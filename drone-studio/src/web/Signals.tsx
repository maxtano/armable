import { useEffect, useReducer } from 'react';
import { runtime } from './controller';
import { Bars, Line } from './Charts';
import { format } from './parts';
import { useStore } from './store';
import { Dial } from './Instruments';

/** A short rolling history of live readings, kept in this tab only. */
const history = { roll: [] as number[], pitch: [] as number[], volts: [] as number[], amps: [] as number[] };
let lastSample = 0;
runtime.on(event => {
  if (event.type !== 'state') return;
  const s = runtime.snapshot().state, now = Date.now();
  if (!s || now - lastSample < 180) return;
  lastSample = now;
  const push = (key: keyof typeof history, value: number | undefined) => { if (value !== undefined) { history[key].push(value); if (history[key].length > 240) history[key].shift(); } };
  push('roll', s.attitude?.roll); push('pitch', s.attitude?.pitch); push('volts', s.battery?.voltage); push('amps', s.battery?.current);
});

/** The readings that matter most, on dials. */
function Gauges() {
  const st = useStore(s => s.snap.state);
  const volts = st?.battery?.voltage, amps = st?.battery?.current, cells = volts ? Math.max(1, Math.round(volts / 3.95)) : undefined;
  const perCell = volts && cells ? volts / cells : undefined, channels = st?.sensors.receiver === 'bad' ? 0 : st?.rc?.channels.length ?? 0;
  const roll = st?.attitude?.roll, pitch = st?.attitude?.pitch, tilt = roll !== undefined && pitch !== undefined ? Math.round(Math.max(Math.abs(roll), Math.abs(pitch))) : undefined;
  return (
    <div className="lu-dials" aria-label="Live readings">
      <Dial label="Battery" reading={volts !== undefined ? `${volts.toFixed(1)} V` : '—'} value={perCell} min={3.2} max={4.35} caution={[3.2, 3.5]} note={perCell ? `${perCell.toFixed(2)} V a cell, ${cells}S` : 'No battery'} tone={perCell !== undefined && perCell < 3.5 ? 'bad' : undefined} />
      <Dial label="Current" reading={amps !== undefined ? `${amps.toFixed(1)} A` : '—'} value={amps} max={Math.max(60, (amps ?? 0) * 1.2)} caution={[45, Math.max(60, (amps ?? 0) * 1.2)]} />
      <Dial label="Tilt" reading={tilt !== undefined ? `${tilt}°` : '—'} value={tilt} max={90} caution={[25, 90]} note={tilt !== undefined && tilt <= 25 ? 'Level enough to arm' : undefined} />
      <Dial label="Radio" reading={channels ? `${channels} ch` : 'No signal'} value={channels} max={18} note={channels ? 'Receiving' : 'Check the receiver'} tone={channels ? undefined : 'warn'} />
    </div>
  );
}

export function Signals() {
  const snap = useStore(s => s.snap), st = snap.state;
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { const t = setInterval(tick, 250); return () => clearInterval(t); }, []);
  if (snap.status !== 'connected' || !st) return <div className="lu-empty"><h2>No drone connected</h2></div>;
  const sensors = Object.entries(st.sensors).filter(([k]) => k !== 'prearm');
  return (
    <section className="lu-page">
      <header className="lu-page-head"><h1>Signals</h1></header>
      <Gauges />
      <div className="lu-grid">
        <article className="lu-card is-wide"><h3>Attitude <small>{format(st.attitude?.roll, '°')} · {format(st.attitude?.pitch, '°')}</small></h3><Line label="Roll and pitch" series={[{ values: history.roll, tone: 'a' }, { values: history.pitch, tone: 'b' }]} unit="°" /><div className="lu-legend"><i className="tone-a" />Roll<i className="tone-b" />Pitch</div></article>
        <article className="lu-card"><h3>Battery <small>{format(st.battery ? Number(st.battery.voltage.toFixed(2)) : undefined, 'V')}</small></h3><Line label="Battery voltage" series={[{ values: history.volts, tone: 'c' }]} unit=" V" height={100} /></article>
        <article className="lu-card"><h3>Current <small>{format(st.battery?.current, 'A')}</small></h3><Line label="Battery current" series={[{ values: history.amps, tone: 'd' }]} unit=" A" min={0} height={100} /></article>
        <article className="lu-card"><h3>Radio <small>{st.rc?.channels.length ? `${st.rc.channels.length} channels` : 'No signal'}</small></h3><Bars values={(st.rc?.channels ?? []).slice(0, 8)} /></article>
        <article className="lu-card"><h3>Motors</h3><Bars values={st.motors?.outputs ?? []} labels={(st.motors?.outputs ?? []).map((_, i) => `M${i + 1}`)} /></article>
        <article className="lu-card"><h3>Sensors</h3><ul className="lu-sensors">{sensors.map(([k, v]) => <li key={k} className={`is-${v}`}><i />{k}</li>)}</ul></article>
        <article className="lu-card"><h3>Messages</h3><ul className="lu-messages">{st.messages.slice(-6).reverse().map(m => <li key={m.at + m.text} className={m.severity <= 3 ? 'is-bad' : ''}>{m.text}</li>)}{!st.messages.length && <li className="is-quiet">Quiet</li>}</ul></article>
      </div>
    </section>
  );
}
