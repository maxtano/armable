import { useRef } from 'react';
import { FileUp } from 'lucide-react';
import { analyzeDataFlash } from '../aircraft/dataflash-analysis';
import { analyzeBlackbox } from '../device/blackbox/analyze';
import { decodeAll, isBlackbox } from '../device/blackbox/decode';
import { runTest, words } from './controller';
import { set, toast } from './store';
import { Line } from './Charts';
import { useStore } from './store';

const tone = (peak: number | undefined) => peak === undefined ? 'muted' : peak > 30 ? 'bad' : peak > 15 ? 'warn' : 'ok';
/** Each recorded flight as charts with the findings on top. */
export function Flights() {
  const snap = useStore(s => s.snap), log = useStore(s => s.log), busy = useStore(s => s.busy), progress = useStore(s => s.progress);
  const list = snap.tests.find(t => t.id === 'logs.list'), analyse = snap.tests.find(t => t.id === 'logs.analyze');
  const input = useRef<HTMLInputElement>(null);
  /** A log file from disk: Betaflight .bbl or ArduPilot .BIN, read here in the browser. */
  const openFile = async (file?: File) => {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const analysis = isBlackbox(bytes) ? (() => { const logs = decodeAll(bytes); if (!logs.length) throw new Error('No flights were found in that file.'); return analyzeBlackbox(logs[logs.length - 1]); })() : analyzeDataFlash(bytes);
      set({ log: { id: 0, analysis } });
      toast(`${file.name} analysed`, 'ok');
    } catch (error) { toast(words(error), 'bad'); }
  };
  const fileButton = <><input ref={input} type="file" hidden accept=".bbl,.bfl,.txt,.bin,.BIN" onChange={e => openFile(e.target.files?.[0])} data-log-file /><button className="lu-btn" onClick={() => input.current?.click()}><FileUp size={14} /> Open a log file</button></>;
  if (snap.status !== 'connected' && !log) return <div className="lu-empty"><h2>No drone connected</h2>{fileButton}</div>;
  const a = log?.analysis, v = a?.vibration?.sensors[0];
  const peak = v ? Math.max(v.vibeX?.peak ?? 0, v.vibeY?.peak ?? 0, v.vibeZ?.peak ?? 0) : undefined;
  return (
    <section className="lu-page">
      <header className="lu-page-head">
        <h1>Flights</h1>{a && <span className="lu-hint">{a.format}</span>}
        {fileButton}
        {list && <button className="lu-btn" disabled={!!busy} onClick={() => runTest(list)}>Refresh</button>}
        {analyse && <button className="lu-btn is-primary" disabled={!!busy} onClick={() => runTest(analyse)}>Analyse latest</button>}
      </header>
      {busy && <div className="lu-progress" role="status"><span>{progress?.label ?? busy}</span>{progress?.total ? <progress value={progress.done ?? 0} max={progress.total} /> : <i />}</div>}
      {snap.logs.length > 0 && analyse && <nav className="lu-chips" aria-label="Logs">{snap.logs.slice(-12).map(l => <button key={l.id} className={log?.id === l.id ? 'is-on' : ''} disabled={!!busy} onClick={() => runTest(analyse, { log: l.id })}>Flight {l.id}<small>{Math.round(l.size / 1024)} KB</small></button>)}</nav>}
      {!a && !busy && <div className="lu-empty"><h2>No flight analysed</h2></div>}
      {a && (
        <>
          <div className="lu-findings">
            <div className={`tone-${tone(peak)}`}><b>{peak === undefined ? '—' : peak < 10 ? peak.toFixed(1) : peak.toFixed(0)}</b><span>Peak vibration</span></div>
            <div className={`tone-${(v?.clippingEvents ?? 0) > 0 ? 'bad' : 'ok'}`}><b>{v?.clippingEvents ?? '—'}</b><span>Clipping</span></div>
            <div><b>{a.rate?.rollErrorDegS?.p95.toFixed(0) ?? '—'}</b><span>Roll error °/s</span></div>
            <div><b>{a.battery?.voltageMinV?.toFixed(1) ?? '—'}</b><span>Lowest volts</span></div>
            <div><b>{a.durationSeconds?.toFixed(0) ?? '—'}</b><span>Seconds</span></div>
          </div>
          <div className="lu-grid">
            <article className="lu-card is-wide"><h3>Vibration</h3><Line label="Vibration" series={[{ values: a.traces.vibration.map(p => p.vibeXMs2), tone: 'a' }, { values: a.traces.vibration.map(p => p.vibeYMs2), tone: 'b' }, { values: a.traces.vibration.map(p => p.vibeZMs2), tone: 'c' }]} min={0} /><div className="lu-legend"><i className="tone-a" />X<i className="tone-b" />Y<i className="tone-c" />Z</div></article>
            {a.traces.attitude.length > 0 && <article className="lu-card is-wide"><h3>Roll · wanted and actual</h3><Line label="Roll" series={[{ values: a.traces.attitude.map(p => p.desiredRollDeg), tone: 'b', dashed: true }, { values: a.traces.attitude.map(p => p.rollDeg), tone: 'a' }]} unit="°" /></article>}
            <article className="lu-card"><h3>Roll rate</h3><Line label="Roll rate" height={100} series={[{ values: a.traces.rate.map(p => p.desiredRollDegS), tone: 'b', dashed: true }, { values: a.traces.rate.map(p => p.rollDegS), tone: 'a' }]} /></article>
            <article className="lu-card"><h3>Throttle</h3><Line label="Throttle" height={100} series={[{ values: a.traces.throttle.map(p => p.output), tone: 'd' }]} min={0} max={1} /></article>
          </div>
          {a.caveats.length > 0 && <p className="lu-hint">{a.caveats[0]}</p>}
        </>
      )}
    </section>
  );
}
