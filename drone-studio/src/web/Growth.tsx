import { useEffect, useState } from 'react';
import { Check, MessageSquarePlus, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { api, ApiError } from '../platform/cloud';
import { captureView } from './capture';
import { connectDemo, go, refreshMe, start } from './controller';
import { get, set, toast, useStore } from './store';
import { isLocalPath } from '../../server/paths';

/**
 * Everything that makes Armable easy to try and easy to talk back to: links that open straight into the demo,
 * a guest bench that can be saved later, a feedback button, and one short question at the right moment.
 */

/** Open Armable, following a link such as /?demo=betaflight or /build. Those links skip sign-up entirely. */
export async function boot() {
  const params = new URLSearchParams(location.search), path = location.pathname;
  const demo = params.get('demo'), build = path === '/build' || path === '/build/';
  const me = await refreshMe();
  const guest = !me.signedIn && !me.offline && (demo === 'betaflight' || demo === 'ardupilot' || build);
  if (guest) await api('POST', '/guest').catch(() => {});
  // Only ask the server who this is again if a guest bench was just made.
  await start(guest ? undefined : me);
  if (!get().me?.signedIn) return;
  if (demo === 'betaflight' || demo === 'ardupilot') { history.replaceState(null, '', '/'); go('drone'); void connectDemo(demo); }
  else if (build) { history.replaceState(null, '', '/'); go('build'); }
}

/** Start a guest bench from the intro page, then carry on where the person was going. */
export async function tryAsGuest(next?: string | null) {
  await api('POST', '/guest');
  if (next && isLocalPath(next)) location.href = next; else await boot();
}

export function GoogleButton({ next, label = 'Continue with Google' }: { next?: string; label?: string }) {
  const href = `/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`;
  return (
    <a className="lu-btn is-google" href={href}>
      <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>
      {label}
    </a>
  );
}

// ---- Saving a guest bench --------------------------------------------------------------------------------------------

export function SaveDialog() {
  const open = useStore(s => s.dialog === 'save'), google = useStore(s => s.me?.google);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  if (!open) return null;
  const close = () => set({ dialog: undefined });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('POST', '/save', { email, password }); await refreshMe(); close(); toast('Saved. Sign in from any browser to get back to it.', 'ok'); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Could not save right now.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="lu-scrim" role="dialog" aria-modal aria-label="Save your bench" onClick={e => e.target === e.currentTarget && close()}>
      <form className="lu-dialog gr-dialog" onSubmit={submit}>
        <header><h2>Save your bench</h2><button type="button" className="lu-icon" onClick={close} aria-label="Close"><X size={17} /></button></header>
        <p className="lu-hint">Keep your builds, settings history and connected assistants, and open them from any browser. Unsaved guest benches are deleted after 30 days without a visit.</p>
        {google && <><GoogleButton next="/" label="Save with Google" /><span className="gr-or">or</span></>}
        <label>Email<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        {error && <p className="in-error" role="alert">{error}</p>}
        <button className="lu-btn is-primary" disabled={busy}>Save</button>
      </form>
    </div>
  );
}

// ---- Feedback --------------------------------------------------------------------------------------------------------

function context() {
  const s = get(), id = s.snap.identity;
  const ua = navigator.userAgent, browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  return { view: s.view, part: s.part, firmware: id ? `${id.firmware} ${id.version}` : undefined, demo: s.snap.demo || undefined, browser, width: innerWidth, assistants: s.me?.assistants?.length ?? 0, lastError: s.toast?.tone === 'bad' ? s.toast.text : undefined };
}

export function FeedbackDialog() {
  const open = useStore(s => s.dialog === 'feedback'), onDrone = useStore(s => s.view === 'drone' && s.snap.status === 'connected');
  const [text, setText] = useState(''), [picture, setPicture] = useState(true), [busy, setBusy] = useState(false), [sent, setSent] = useState(false);
  useEffect(() => { if (open) { setSent(false); setText(''); } }, [open]);
  if (!open) return null;
  const close = () => set({ dialog: undefined });
  const send = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      const shot = picture && onDrone ? await captureView('drone') : undefined;
      await api('POST', '/feedback', { text, context: context(), screenshot: shot?.png ? `data:image/png;base64,${shot.png}` : undefined });
      setSent(true); setTimeout(close, 1600);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not send. Try again.', 'bad'); }
    finally { setBusy(false); }
  };
  return (
    <div className="lu-scrim" role="dialog" aria-modal aria-label="Send feedback" onClick={e => e.target === e.currentTarget && close()}>
      <form className="lu-dialog gr-dialog" onSubmit={send}>
        <header><h2>Feedback</h2><button type="button" className="lu-icon" onClick={close} aria-label="Close"><X size={17} /></button></header>
        {sent ? <p className="gr-thanks"><Check size={18} /> Thank you. Every note is read.</p> : <>
          <p className="lu-hint">What worked, what didn’t, what you wish it did. Anything helps.</p>
          <textarea autoFocus rows={5} maxLength={4000} required value={text} onChange={e => setText(e.target.value)} placeholder="It would be better if…" aria-label="Your feedback" />
          {onDrone && <label className="bd-toggle"><input type="checkbox" checked={picture} onChange={e => setPicture(e.target.checked)} /> Attach a picture of the drone view</label>}
          <p className="lu-hint">Sent with the page you’re on, your browser and firmware, so we can reproduce it. Nothing else.</p>
          <button className="lu-btn is-primary" disabled={busy || !text.trim()}>Send</button>
        </>}
      </form>
    </div>
  );
}

export function FeedbackButton() {
  return <button onClick={() => set({ dialog: 'feedback' })} aria-label="Send feedback" title="Send feedback"><MessageSquarePlus size={18} /><span className="lu-rail-label">Feedback</span></button>;
}

/** One question, once, after the first fix or the first finished build. */
export function HelpfulPrompt() {
  const moment = useStore(s => s.helpful), [answer, setAnswer] = useState<boolean>(), [note, setNote] = useState('');
  useEffect(() => { setAnswer(undefined); setNote(''); }, [moment]);
  if (!moment) return null;
  const close = () => set({ helpful: undefined });
  const send = async (helpful: boolean, text = '') => { await api('POST', '/feedback', { kind: 'helpful', helpful, text, context: { ...context(), moment } }).catch(() => {}); };
  return (
    <aside className="gr-helpful" aria-label="Did this help?">
      <button className="lu-icon" onClick={close} aria-label="Close"><X size={15} /></button>
      {answer === undefined ? <>
        <b>{moment === 'fix' ? 'Did that fix help?' : 'Was building this easy?'}</b>
        <div className="lu-row"><button className="lu-btn" onClick={() => { setAnswer(true); void send(true); }}><ThumbsUp size={15} /> Yes</button><button className="lu-btn" onClick={() => { setAnswer(false); void send(false); }}><ThumbsDown size={15} /> Not really</button></div>
      </> : <form onSubmit={e => { e.preventDefault(); if (note.trim()) void send(answer, note); close(); toast('Thank you.', 'ok'); }}>
        <b>{answer ? 'Great. Anything we should add?' : 'Sorry. What got in the way?'}</b>
        <textarea rows={2} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder="Optional" aria-label="Tell us more" />
        <button className="lu-btn is-primary">{note.trim() ? 'Send' : 'Done'}</button>
      </form>}
    </aside>
  );
}
