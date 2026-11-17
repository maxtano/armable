/** Small SVG charts. No library: a line is a polyline. */
export function Line({ series, height = 120, min, max, unit, label }: { series: { values: number[]; tone?: string; dashed?: boolean }[]; height?: number; min?: number; max?: number; unit?: string; label?: string }) {
  const all = series.flatMap(s => s.values).filter(Number.isFinite);
  if (all.length < 2) return <div className="lu-chart is-empty" style={{ height }} aria-label={label}>—</div>;
  const lo = min ?? Math.min(...all), hi = max ?? Math.max(...all), span = hi - lo || 1;
  const points = (values: number[]) => values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * 600).toFixed(1)},${(height - 8 - ((v - lo) / span) * (height - 16)).toFixed(1)}`).join(' ');
  return (
    <svg className="lu-chart" viewBox={`0 0 600 ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <line className="lu-chart-axis" x1="0" x2="600" y1={height - 8} y2={height - 8} />
      {lo < 0 && hi > 0 && <line className="lu-chart-zero" x1="0" x2="600" y1={height - 8 - ((0 - lo) / span) * (height - 16)} y2={height - 8 - ((0 - lo) / span) * (height - 16)} />}
      {series.map((s, i) => <polyline key={i} className={`lu-chart-line tone-${s.tone ?? 'a'}${s.dashed ? ' is-dashed' : ''}`} points={points(s.values)} />)}
      <text className="lu-chart-max" x="596" y="12">{Number(hi.toFixed(1))}{unit ?? ''}</text>
      <text className="lu-chart-min" x="596" y={height - 12}>{Number(lo.toFixed(1))}{unit ?? ''}</text>
    </svg>
  );
}
export function Bars({ values, min = 1000, max = 2000, labels }: { values: number[]; min?: number; max?: number; labels?: string[] }) {
  return (
    <div className="lu-bars" role="img" aria-label="Bars">
      {values.map((v, i) => <div key={i}><i style={{ height: `${Math.max(2, Math.min(100, ((v - min) / (max - min)) * 100))}%` }} /><span>{labels?.[i] ?? i + 1}</span></div>)}
    </div>
  );
}
