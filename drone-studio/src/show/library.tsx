import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { Project } from '../core/model';
import { STORYBOARDS_STORAGE_KEY, type StoredStoryboard } from '../core/storyboards';
import { api } from '../platform/cloud';

const Studio = lazy(() => import('./Studio'));
const CURRENT = 'armable.studio.project.v1';

/**
 * The storyboard editor keeps its library in a Storage object. This one is backed by the account: reads come
 * from documents fetched before the editor mounts, and every save is pushed to the cloud as a revisioned write.
 */
class CloudStorage implements Storage {
  private local = new Map<string, string>();
  private known = new Map<string, { doc: string; rev: number; json: string }>();
  private timer?: ReturnType<typeof setTimeout>;
  constructor(entries: { doc: string; rev: number; project: Project; updatedAt: number }[], private onConflict: () => void) {
    for (const e of entries) this.known.set(e.project.id, { doc: e.doc, rev: e.rev, json: JSON.stringify(e.project) });
    this.local.set(STORYBOARDS_STORAGE_KEY, JSON.stringify(entries.map(e => ({ project: e.project, updatedAt: e.updatedAt }) satisfies StoredStoryboard)));
    const latest = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) this.local.set(CURRENT, JSON.stringify(latest.project));
  }
  get length() { return this.local.size; }
  key(i: number) { return [...this.local.keys()][i] ?? null; }
  getItem(key: string) { return this.local.get(key) ?? null; }
  removeItem(key: string) { this.local.delete(key); }
  clear() { this.local.clear(); }
  setItem(key: string, value: string) {
    this.local.set(key, value);
    if (key !== STORYBOARDS_STORAGE_KEY) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.push(value), 600);
  }
  private async push(value: string) {
    let library: StoredStoryboard[];
    try { library = JSON.parse(value); } catch { return; }
    for (const entry of library) {
      const json = JSON.stringify(entry.project), known = this.known.get(entry.project.id);
      try {
        if (entry.deletedAt !== undefined) { if (known) { await api('DELETE', `/docs/${known.doc}`); this.known.delete(entry.project.id); } continue; }
        if (!known) { const made = await api('POST', '/docs', { kind: 'storyboard', name: entry.project.name, content: entry.project }); this.known.set(entry.project.id, { doc: made.id, rev: made.revision, json }); }
        else if (known.json !== json) { const saved = await api('PUT', `/docs/${known.doc}`, { baseRevision: known.rev, content: entry.project, name: entry.project.name }); this.known.set(entry.project.id, { ...known, rev: saved.revision, json }); }
      } catch { this.onConflict(); return; }
    }
  }
}

/**
 * The storyboard library for this account, and the editor on top of it. `revision` goes up whenever the cloud says
 * a document changed, which is what makes a storyboard edited elsewhere arrive here.
 */
export function ShowLibrary({ revision, onLeaveToBench }: { revision: number; onLeaveToBench?: () => void }) {
  const [entries, setEntries] = useState<{ doc: string; rev: number; project: Project; updatedAt: number }[]>();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const list = (await api('GET', '/docs') as { id: string; kind: string }[]).filter(d => d.kind === 'storyboard');
      const loaded = await Promise.all(list.map(async d => { const full = await api('GET', `/docs/${d.id}`); return { doc: d.id, rev: full.revision as number, project: full.content as Project, updatedAt: full.updatedAt as number, by: full.updatedBy as string }; }));
      if (!alive) return;
      // Remount the editor only when something arrived from outside this tab's own saves.
      setEntries(previous => { const changed = !previous || loaded.some(l => l.by !== 'you' && previous.find(p => p.doc === l.doc)?.rev !== l.rev) || loaded.length < previous.length; if (changed) setGeneration(g => g + 1); return changed ? loaded : previous; });
    })();
    return () => { alive = false; };
  }, [revision]);
  const storage = useMemo(() => entries && new CloudStorage(entries, () => setGeneration(g => g + 1)), [entries, generation]);
  if (!storage) return <div className="sh-loading" role="status"><h2>Loading your storyboards</h2></div>;
  return <Suspense fallback={<div className="sh-loading" role="status"><h2>Loading the editor</h2></div>}><Studio key={generation} storage={storage} onPlatformHome={onLeaveToBench} /></Suspense>;
}
