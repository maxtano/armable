import { useEffect, useReducer } from 'react';
import { runtime } from './controller';
import { Bars, Line } from './Charts';
import { format } from './parts';
import { useStore } from './store';

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

export function Signals() {
  const snap = useStore(s => s.snap), st = snap.state;
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { const t = setInterval(tick, 250); return () => clearInterval(t); }, []);
  if (snap.status !== 'connected' || !st) return <div className="lu-empty"><h2>No drone connected</h2></div>;
  const sensors = Object.entries(st.sensors).filter(([k]) => k !== 'prearm');
  return (
    <section className="lu-page">
      <header className="lu-page-head"><h1>Signals</h1></header>
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
