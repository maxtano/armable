import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, RotateCcw } from 'lucide-react';
import { osdLayout, type OsdElement } from '../device/betaflight/osd';
import { applyChanges } from './controller';
import { useStore } from './store';

/** Drag elements on a picture of the goggles screen. Nothing is written until Save. */
export function OsdEditor() {
  const settings = useStore(s => s.settings), busy = useStore(s => !!s.busy);
  const layout = useMemo(() => osdLayout(settings), [settings]);
  const [draft, setDraft] = useState<Record<string, { x: number; y: number; visible: boolean }>>({});
  const [drag, setDrag] = useState<string>();
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => { setDraft({}); }, [layout?.elements.map(e => e.value).join()]);
  if (!layout) return <div className="lu-empty"><h2>No OSD on this aircraft</h2></div>;
  const state = (e: OsdElement) => draft[e.id] ?? { x: e.pos.x, y: e.pos.y, visible: e.visible };
  const changed = layout.elements.filter(e => { const d = draft[e.id]; return d && (d.x !== e.pos.x || d.y !== e.pos.y || d.visible !== e.visible); });
  const cell = (event: React.PointerEvent) => {
    const r = grid.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(layout.columns - 1, Math.floor(((event.clientX - r.left) / r.width) * layout.columns))), y: Math.max(0, Math.min(layout.rows - 1, Math.floor(((event.clientY - r.top) / r.height) * layout.rows))) };
  };
  const set = (e: OsdElement, patch: Partial<{ x: number; y: number; visible: boolean }>) => setDraft(d => ({ ...d, [e.id]: { ...state(e), ...patch } }));
  const save = () => applyChanges(changed.map(e => { const d = state(e); return { id: e.id, value: `${d.x},${d.y},${d.visible ? 'on' : 'off'}`, expected: e.value }; }));
  return (
    <div className="lu-osd">
      <div className="lu-osd-screen" ref={grid} style={{ aspectRatio: `${layout.columns * 12} / ${layout.rows * 18}` }} data-osd-grid
        onPointerMove={ev => { if (!drag) return; const e = layout.elements.find(x => x.id === drag)!; set(e, cell(ev)); }}
        onPointerUp={() => setDrag(undefined)} onPointerLeave={() => setDrag(undefined)}>
        {layout.elements.filter(e => state(e).visible).map(e => {
          const d = state(e);
          return (
            <button key={e.id} className={`lu-osd-el${drag === e.id ? ' is-dragging' : ''}${draft[e.id] ? ' is-moved' : ''}`} data-osd={e.key}
              style={{ left: `${(d.x / layout.columns) * 100}%`, top: `${(d.y / layout.rows) * 100}%` }}
              onPointerDown={ev => { ev.preventDefault(); (ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId); setDrag(e.id); }}
              onKeyDown={ev => { const m: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }; const k = m[ev.key]; if (k) { ev.preventDefault(); set(e, { x: Math.max(0, Math.min(layout.columns - 1, d.x + k[0])), y: Math.max(0, Math.min(layout.rows - 1, d.y + k[1])) }); } }}
              aria-label={`${e.name}, column ${d.x}, row ${d.y}. Arrow keys move it.`}>{e.name}</button>
          );
        })}
      </div>
      <div className="lu-row">
        <span className="lu-hint">{layout.system} · {layout.columns}×{layout.rows}</span>
        <span className="lu-row-gap" />
        {changed.length > 0 && <button className="lu-btn" onClick={() => setDraft({})}><RotateCcw size={14} /> Reset</button>}
        <button className="lu-btn is-primary" disabled={busy || !changed.length} onClick={save}>Save {changed.length || ''}</button>
      </div>
      <ul className="lu-osd-list" aria-label="Elements">
        {layout.elements.map(e => { const d = state(e); return (
          <li key={e.id}><button className={`lu-icon${d.visible ? ' is-on' : ''}`} aria-pressed={d.visible} aria-label={`${d.visible ? 'Hide' : 'Show'} ${e.name}`} onClick={() => set(e, { visible: !d.visible })}>{d.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button><span>{e.name}</span></li>
        ); })}
      </ul>
    </div>
  );
}
