import { useEffect, useState } from 'react';
import { api } from '../platform/cloud';
import { format } from './parts';

/** What happened, from the tracking tables: assistant calls, changes, tests, connections. */
type Row = Record<string, any>;
const TABS: [string, string][] = [['tool_calls', 'Assistant calls'], ['setting_changes', 'Changes'], ['test_runs', 'Tests'], ['proposal_events', 'Proposals'], ['aircraft_connections', 'Connections'], ['telemetry_samples', 'Telemetry'], ['aircraft', 'Aircraft']];
const when = (at: string) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const short = (v: unknown) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t && t.length > 90 ? `${t.slice(0, 88)}…` : t ?? '—'; };

export function History() {
  const [summary, setSummary] = useState<Record<string, number>>(), [tab, setTab] = useState('tool_calls'), [rows, setRows] = useState<Row[]>(), [open, setOpen] = useState<number>();
  useEffect(() => { void api('GET', '/data').then(setSummary).catch(() => setSummary({})); }, []);
  useEffect(() => { setRows(undefined); void api('GET', `/data/${tab}?limit=200`).then(setRows).catch(() => setRows([])); }, [tab]);
  const cols: Record<string, [string, (r: Row) => unknown][]> = {
    tool_calls: [['When', r => when(r.at)], ['Who', r => r.assistant], ['Tool', r => r.tool], ['Input', r => short(r.input)], ['Result', r => r.ok ? 'ok' : r.error_code], ['ms', r => r.duration_ms]],
    setting_changes: [['When', r => when(r.at)], ['Who', r => r.by_who], ['Setting', r => r.setting_id], ['Before', r => format(r.before)], ['After', r => format(r.after)], ['Result', r => r.ok ? 'confirmed' : short(r.note)]],
    test_runs: [['When', r => when(r.at)], ['Who', r => r.by_who], ['Test', r => r.test_id], ['Result', r => r.ok === null ? 'see summary' : r.ok ? 'pass' : 'fail'], ['Summary', r => short(r.summary)]],
    proposal_events: [['When', r => when(r.at)], ['Who', r => r.assistant], ['Proposal', r => r.proposal_id], ['Status', r => r.status], ['What', r => short(r.changes ?? r.test)], ['Permission', r => r.grant_id ? 'standing' : '']],
    aircraft_connections: [['When', r => when(r.at)], ['Event', r => r.event], ['Port', r => r.port], ['Aircraft', r => r.aircraft_id]],
    telemetry_samples: [['When', r => when(r.at)], ['Volts', r => format(r.voltage)], ['Amps', r => format(r.current)], ['RSSI', r => format(r.rssi)], ['Sats', r => format(r.sats)], ['Armed', r => r.armed ? 'yes' : 'no'], ['Mode', r => r.mode]],
    aircraft: [['Name', r => r.craft_name ?? '—'], ['Firmware', r => `${r.firmware} ${r.version}`], ['Board', r => r.board], ['Demo', r => r.demo ? 'yes' : ''], ['First seen', r => when(r.first_seen)], ['Last seen', r => when(r.last_seen)]],
  };
  return (
    <section className="lu-page">
      <header className="lu-page-head"><h1>History</h1><a className="lu-btn" href={`/api/data/${tab}?limit=5000`} download={`armable-${tab}.json`}>Download</a></header>
      <nav className="lu-chips" aria-label="Tables">{TABS.map(([id, label]) => <button key={id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>{label}<small>{summary?.[id] ?? ''}</small></button>)}</nav>
      <div className="lu-table lu-history" role="table">
        <div className="lu-hrow is-head" role="row">{cols[tab].map(([h]) => <span key={h} role="columnheader">{h}</span>)}</div>
        {rows?.map((r, i) => (
          <div key={r.id ?? i} role="row" className={`lu-hrow${open === i ? ' is-open' : ''}${r.ok === false ? ' is-bad' : ''}`} onClick={() => setOpen(open === i ? undefined : i)}>
            {cols[tab].map(([h, f]) => <span key={h} role="cell">{String(f(r) ?? '—')}</span>)}
            {open === i && <pre className="lu-hdetail">{JSON.stringify(r, null, 2)}</pre>}
          </div>
        ))}
        {rows && !rows.length && <p className="lu-hint lu-hempty">Nothing yet</p>}
      </div>
    </section>
  );
}
