import { useRef, useSyncExternalStore } from 'react';
import type { FlightLogAnalysis } from '../aircraft/dataflash-analysis';
import type { AircraftSnapshot } from '../device/runtime';
import type { PartId, PromptRequest, Setting } from '../device/types';
import type { Reference } from '../map/library';

/** Everything the interface shows, in one place. Small on purpose: no library, one subscribe function. */
export type View = 'drone' | 'signals' | 'flights' | 'show' | 'sound' | 'settings' | 'connect';
export type AssistantMode = 'off' | 'observe' | 'propose';
export interface Me { signedIn: boolean; email?: string; mode?: AssistantMode; mcpUrl?: string; assistants?: { clientId: string; name: string; scopes: string[]; lastSeen: number | null }[] }
export interface ProposalCard {
  id: string; kind: 'change' | 'test'; by: string; reason?: string; level: 2 | 3; needs: string[]; part?: string;
  changes?: { id: string; value: string | number; expected?: string | number; before?: unknown; title?: string }[];
  test?: { id: string; name: string; args?: Record<string, unknown> };
  status: string; expiresAt: number; result?: { ok: boolean | null; summary: string };
}
export interface ActivityItem { id: string; at: number; who: string; kind: string; title: string; part?: string; ids?: string[]; ok?: boolean | null; detail?: any }
export interface DocMeta { id: string; revision: number; kind: 'storyboard' | 'tune' | 'file' | 'snapshot'; name: string; updatedBy: string; updatedAt: number; canUndo: boolean }
/** A visible trace of something that just happened to a part or setting. */
export interface Mark { kind: 'reading' | 'changed'; by: string; at: number }
export interface State {
  me?: Me;
  view: View;
  part?: PartId;
  motor?: number;
  snap: AircraftSnapshot;
  settings: Setting[];
  log?: { id: number; analysis: FlightLogAnalysis };
  proposals: ProposalCard[];
  activity: ActivityItem[];
  docs: DocMeta[];
  marks: Record<string, Mark>;
  progress?: { label: string; done?: number; total?: number };
  toast?: { text: string; tone: 'ok' | 'bad' | 'info'; at: number };
  reference?: Reference;
  live: boolean;
  follow: boolean;
  prompt?: { request: PromptRequest; resolve(value: unknown): void };
  busy?: string;
  consent?: string;
  docRevision: number;
}
export const EMPTY_SNAP: AircraftSnapshot = { status: 'idle', settingsLoaded: 'none', settingsCount: 0, tests: [], escs: [], logs: [] };
let state: State = { view: 'drone', snap: EMPTY_SNAP, settings: [], proposals: [], activity: [], docs: [], marks: {}, live: false, follow: true, docRevision: 0 };
const listeners = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  return false;
}
/** Read part of the state. A selector may build a new array; it only re-renders when the contents change. */
export function useStore<T>(select: (s: State) => T): T {
  const last = useRef<{ value: T } | undefined>(undefined);
  return useSyncExternalStore(subscribe, () => {
    const value = select(state);
    if (last.current && shallowEqual(last.current.value, value)) return last.current.value;
    last.current = { value };
    return value;
  });
}
export function toast(text: string, tone: 'ok' | 'bad' | 'info' = 'info') { set({ toast: { text, tone, at: Date.now() } }); }
export function mark(key: string, kind: Mark['kind'], by: string) {
  set(s => ({ marks: { ...s.marks, [key]: { kind, by, at: Date.now() } } }));
  if (kind === 'reading') setTimeout(() => set(s => { const m = s.marks[key]; if (!m || m.kind !== 'reading' || Date.now() - m.at < 1400) return {}; const { [key]: _gone, ...rest } = s.marks; return { marks: rest }; }), 1500);
}
export function clearMark(key: string) { set(s => { const { [key]: _gone, ...rest } = s.marks; return { marks: rest }; }); }
