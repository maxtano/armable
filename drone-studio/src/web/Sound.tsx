import { useEffect, useRef, useState } from 'react';
import { Play, Plus, Square, Trash2 } from 'lucide-react';
import { api, ApiError } from '../platform/cloud';
import { refreshDocs } from './controller';
import { toast, useStore } from './store';

interface Note { midi: number | null; beats: number }
interface Tune { name: string; bpm: number; notes: Note[] }
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const name = (midi: number | null) => midi === null ? '·' : `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
const STARTER: Tune = { name: 'First light', bpm: 144, notes: [{ midi: 60, beats: 0.5 }, { midi: 64, beats: 0.5 }, { midi: 67, beats: 0.5 }, { midi: 72, beats: 1 }] };

/** A small melody composer. Tunes are saved to the account; an assistant can write them too. */
export function Sound() {
  const docs = useStore(s => s.docs.filter(d => d.kind === 'tune')), rev = useStore(s => s.docRevision);
  const [id, setId] = useState<string>(), [revision, setRevision] = useState(0), [tune, setTune] = useState<Tune>(STARTER), [beats, setBeats] = useState(0.5), [playing, setPlaying] = useState(-1);
  const audio = useRef<AudioContext | undefined>(undefined), stopAt = useRef<ReturnType<typeof setTimeout>[]>([]);
  const open = async (doc: string) => { const d = await api('GET', `/docs/${doc}`); setId(doc); setRevision(d.revision); setTune({ name: d.name, bpm: d.content.bpm, notes: d.content.notes }); };
  useEffect(() => { if (id) void open(id).catch(() => {}); }, [rev]);
  const stop = () => { stopAt.current.forEach(clearTimeout); stopAt.current = []; void audio.current?.close(); audio.current = undefined; setPlaying(-1); };
  useEffect(() => stop, []);
  const play = () => {
    stop();
    const ctx = audio.current = new AudioContext();
    let t = ctx.currentTime + 0.05, ms = 50;
    tune.notes.forEach((n, i) => {
      const seconds = (60 / tune.bpm) * n.beats;
      if (n.midi !== null) {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'square'; osc.frequency.value = 440 * 2 ** ((n.midi - 69) / 12);
        gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(0.08, t + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds * 0.92);
        osc.connect(gain).connect(ctx.destination); osc.start(t); osc.stop(t + seconds);
      }
      stopAt.current.push(setTimeout(() => setPlaying(i), ms));
      t += seconds; ms += seconds * 1000;
    });
    stopAt.current.push(setTimeout(stop, ms + 100));
  };
  const save = async () => {
    const content = { bpm: tune.bpm, notes: tune.notes };
    try {
      if (id) setRevision((await api('PUT', `/docs/${id}`, { baseRevision: revision, content, name: tune.name })).revision);
      else { const made = await api('POST', '/docs', { kind: 'tune', name: tune.name, content }); setId(made.id); setRevision(made.revision); }
      await refreshDocs(); toast('Saved', 'ok');
    } catch (error) { toast(error instanceof ApiError ? error.message : 'Could not save', 'bad'); if (id) void open(id); }
  };
  const add = (midi: number | null) => tune.notes.length < 128 && setTune({ ...tune, notes: [...tune.notes, { midi, beats }] });
  return (
    <section className="lu-page is-narrow">
      <header className="lu-page-head">
        <h1>Sound</h1>
        <button className="lu-btn" onClick={() => { stop(); setId(undefined); setRevision(0); setTune({ ...STARTER, name: 'New tune', notes: [] }); }}><Plus size={14} /> New</button>
        <button className="lu-btn is-primary" onClick={save} disabled={!tune.notes.length}>Save</button>
      </header>
      {docs.length > 0 && <nav className="lu-chips" aria-label="Saved tunes">{docs.map(d => <button key={d.id} className={id === d.id ? 'is-on' : ''} onClick={() => open(d.id)}>{d.name}</button>)}</nav>}
      <div className="lu-card lu-composer">
        <div className="lu-row">
          <input className="lu-text lu-title" aria-label="Tune name" value={tune.name} maxLength={60} onChange={e => setTune({ ...tune, name: e.target.value })} />
          <label className="lu-tempo">Tempo<input type="range" min={60} max={240} value={tune.bpm} onChange={e => setTune({ ...tune, bpm: Number(e.target.value) })} /><b>{tune.bpm}</b></label>
          <button className="lu-btn is-round" onClick={playing >= 0 ? stop : play} disabled={!tune.notes.length} aria-label={playing >= 0 ? 'Stop' : 'Play'}>{playing >= 0 ? <Square size={15} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
        </div>
        <ol className="lu-score" aria-label="Notes">
          {tune.notes.map((n, i) => (
            <li key={i} className={`${playing === i ? 'is-playing' : ''}${n.midi === null ? ' is-rest' : ''}`} style={{ flexGrow: n.beats * 2, ['--pitch' as string]: n.midi === null ? 0.5 : (n.midi - 48) / 36 }}>
              <button onClick={() => setTune({ ...tune, notes: tune.notes.filter((_, k) => k !== i) })} aria-label={`Remove ${name(n.midi)}`}><span>{name(n.midi)}</span><Trash2 size={11} /></button>
            </li>
          ))}
          {!tune.notes.length && <li className="is-empty">Tap keys below</li>}
        </ol>
        <div className="lu-row">
          <div className="lu-segments" role="radiogroup" aria-label="Note length">{[[0.25, '¼'], [0.5, '½'], [1, '1'], [2, '2']].map(([b, l]) => <button key={b} role="radio" aria-checked={beats === b} onClick={() => setBeats(Number(b))}>{l}</button>)}</div>
          <button className="lu-btn" onClick={() => add(null)}>Rest</button>
        </div>
        <div className="lu-keys" role="group" aria-label="Keyboard">{Array.from({ length: 25 }, (_, i) => 60 + i).map(midi => <button key={midi} className={NAMES[midi % 12].includes('♯') ? 'is-black' : ''} onClick={() => add(midi)} aria-label={name(midi)}><span>{NAMES[midi % 12].includes('♯') ? '' : name(midi)}</span></button>)}</div>
      </div>
    </section>
  );
}
