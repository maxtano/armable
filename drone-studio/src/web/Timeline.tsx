import { useState } from 'react';
import { Activity, Eye, Hand, Pencil, Plug, Pointer, SlidersHorizontal } from 'lucide-react';
import type { PartId } from '../device/types';
import { select } from './controller';
import { format } from './parts';
import { useStore, type ActivityItem } from './store';

const ICON: Record<string, typeof Eye> = { read: Eye, test: Activity, change: SlidersHorizontal, edit: Pencil, proposal: Hand, connect: Plug, show: Pointer };
const ago = (at: number) => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

/** A thin strip of dots, one per action by you or an assistant. It replaces a text log. */
export function Timeline() {
  const activity = useStore(s => s.activity);
  const [open, setOpen] = useState<ActivityItem | undefined>();
  const items = activity.slice(-80);
  return (
    <footer className="lu-timeline" aria-label="Activity">
      {items.length === 0 && <span className="lu-timeline-empty">Nothing yet</span>}
      <ol>
        {items.map(item => {
          const Icon = ICON[item.kind] ?? Activity;
          const mine = item.who === 'you';
          return (
            <li key={item.id}>
              <button className={`lu-dot kind-${item.kind}${mine ? '' : ' is-assistant'}${item.ok === false ? ' is-bad' : ''}${open?.id === item.id ? ' is-open' : ''}`}
                aria-label={`${mine ? 'You' : item.who}: ${item.title}`} onClick={() => { setOpen(open?.id === item.id ? undefined : item); if (item.part) select(item.part as PartId); }}
                onMouseEnter={() => setOpen(item)} onMouseLeave={() => setOpen(o => (o?.id === item.id ? undefined : o))}>
                <Icon size={13} />
              </button>
            </li>
          );
        })}
      </ol>
      {open && (
        <div className="lu-pop" role="status">
          <b>{open.who === 'you' ? 'You' : open.who}</b><span>{open.title}</span><time>{ago(open.at)}</time>
          {open.detail?.changes?.slice(0, 3).map((c: { id: string; before: unknown; after: unknown; ok: boolean }) => <code key={c.id}>{c.id}: {format(c.before)} → {format(c.after)}{c.ok ? '' : ' ✕'}</code>)}
          {!open.detail?.changes && open.detail?.summary && <em>{String(open.detail.summary).slice(0, 140)}</em>}
        </div>
      )}
    </footer>
  );
}
