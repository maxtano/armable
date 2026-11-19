import { useEffect, useState } from 'react';
import { Cable, Eye, MessageSquare, MousePointerClick } from 'lucide-react';
import { api, ApiError } from '../platform/cloud';
import { AiButtons, ClaudeSetup, FIRST_MESSAGE } from './ClaudeSetup';
import { ConnectMenu } from './ConnectMenu';
import { Stator } from './Diagram';
import { Coil } from './Instruments';
import { GoogleButton, tryAsGuest } from './Growth';
import { isLocalPath } from '../../server/paths';

/**
 * The intro page. One picture explains the product, with the most common new-build problem: it will not arm.
 * You say it, the assistant finds the cause on the drone, you approve, it arms. The picture plays on a loop;
 * with reduced motion it rests on the last frame.
 */
const PHASES = ['say', 'look', 'propose', 'approve', 'done'] as const;
const LINES: Record<(typeof PHASES)[number], [string, string?]> = {
  say: ['My new quad won’t arm.'],
  look: ['My new quad won’t arm.', 'Checking… the flight controller hears nothing from the receiver.'],
  propose: ['My new quad won’t arm.', 'Your ExpressLRS receiver speaks CRSF, but the flight controller is set to SBUS. Approve the switch?'],
  approve: ['My new quad won’t arm.', 'Your ExpressLRS receiver speaks CRSF, but the flight controller is set to SBUS. Approve the switch?'],
  done: ['My new quad won’t arm.', 'Done. The receiver is talking and nothing blocks arming.'],
};
function Scene() {
  const still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [phase, setPhase] = useState(still ? 4 : 0);
  useEffect(() => {
    if (still) return;
    const times = [2000, 2200, 2600, 1300, 3400];
    const t = setTimeout(() => setPhase((phase + 1) % PHASES.length), times[phase]);
    return () => clearTimeout(t);
  }, [phase, still]);
  const p = PHASES[phase], fixed = p === 'done';
  const motors: [number, number, number, 'cw' | 'ccw'][] = [[1, 262, 96, 'ccw'], [2, 82, 250, 'ccw'], [3, 82, 96, 'cw'], [4, 262, 250, 'cw']];
  const [you, ai] = LINES[p];
  return (
    <div className={`in-scene is-${p}`} aria-hidden>
      <svg viewBox="0 0 396 346" className="in-drone">
        <defs><pattern id="in-grid" width="33" height="33" patternUnits="userSpaceOnUse"><path d="M 33 0 L 0 0 0 33" className="dg-grid-line" fill="none" /></pattern></defs>
        <rect width="396" height="346" fill="url(#in-grid)" rx="6" />
        {motors.map(([n, x, y]) => <line key={n} className="dg-arm" x1="172" y1="173" x2={x} y2={y} />)}
        <path className={`dg-wire${fixed ? ' flows' : ''}`} d="M 204 173 H 318" />
        <rect className="dg-plate" x="140" y="141" width="64" height="64" rx="8" />
        <circle className="dg-bezel" cx="172" cy="173" r="18" />
        <line className="dg-horizon-line" x1="158" x2="186" y1="173" y2="173" />
        {motors.map(([n, x, y, spin]) => (
          <g key={n} transform={`translate(${x} ${y})`} className="dg-part dg-motor">
            <circle className="dg-disc" r="38" /><Stator r={19} /><circle className="dg-ring" r="43" />
            <g className={`dg-spin ${spin}`}><g transform={spin === 'ccw' ? 'scale(-1 1)' : undefined}><g className="dg-arrows">{[0, 180].map(a => <g key={a} transform={`rotate(${a})`}><path d="M -25.1 -14.5 A 29 29 0 0 1 18.6 -22.2" fill="none" /><path d="M 11.6 -27.2 L 18.6 -22.2 L 13.2 -15.9" fill="none" /></g>)}</g></g></g>
            <circle className="dg-hub" r="11" /><text className="dg-num" y="4">{n}</text>
          </g>
        ))}
        {!fixed && <g className="dg-chip" transform="translate(172 124)"><rect x="-44" y="-12" width="88" height="24" rx="12" /><text y="4.5">Won’t arm</text></g>}
        <g transform="translate(346 173)" className={`dg-part dg-radio${p === 'look' ? ' is-reading' : ''}${p === 'propose' || p === 'approve' ? ' needs-you' : ''}${fixed ? ' is-changed' : ''}`}>
          <circle className="dg-track" r="36" /><circle className="dg-sweep" r="42" pathLength="100" />
          {[0, 1, 2, 3].map(i => { const h = fixed ? [24, 14, 30, 8][i] : 5; return <rect key={i} className="dg-stick" x={-17 + i * 9} y={10 - h} width="6" height={h} rx="2" />; })}
          {!fixed && <path className="dg-cross" d="M -9 -24 L 9 -6 M 9 -24 L -9 -6" />}
          <text className="dg-tag" y="56">Receiver</text>
          {(p === 'propose' || p === 'approve') && <g className={`dg-approve${p === 'approve' ? ' is-pressed' : ''}`} transform="translate(-16 -62)"><rect x="-40" y="-13" width="80" height="26" rx="13" /><text y="4.5">Approve</text></g>}
        </g>
        {fixed && <g className="dg-chip is-ok" transform="translate(172 124)"><rect x="-40" y="-12" width="80" height="24" rx="12" /><text y="4.5">Ready</text></g>}
      </svg>
      <div className="in-chat">
        <p className="in-you">{you}</p>
        <p className={`in-ai${ai ? ' is-in' : ''}`}>{ai ?? ' '}</p>
      </div>
    </div>
  );
}

export function Landing({ onSignedIn, google }: { onSignedIn(): void; google?: boolean }) {
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<'signup' | 'login'>('login'), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(params.get('signin') ?? ''), [busy, setBusy] = useState(false);
  const next = params.get('next');
  // An assistant app sent the person here to allow it: one screen, one button.
  if (next?.startsWith('/authorize')) return <AllowAssistant next={next} google={google} />;
  const guest = async () => { setBusy(true); try { await tryAsGuest(next); } catch { setError('Could not start right now. Try again.'); setBusy(false); } };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api('POST', mode === 'signup' ? '/signup' : '/login', { email, password });
      // An assistant app, or Armable Shows, sent them here to sign in first: carry on with that request.
      if (next && isLocalPath(next)) location.href = next; else onSignedIn();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not reach Armable.'); setBusy(false); }
  };
  return (
    <div className="in">
      <header className="in-top"><span className="in-logo"><img src="/favicon.svg" alt="" width="22" height="22" />Armable</span><a href="#start" className="lu-btn">Sign in</a></header>
      <section className="in-hero">
        <div className="in-copy">
          <Coil width={150} height={38} />
          <h1>Your drone.<br />Your AI.<br /><em>One bench.</em></h1>
          <p>Plug in your drone. Tell Claude or ChatGPT what’s wrong. Watch the fix happen.</p>
          <h2 className="in-ask">Which AI do you use?</h2>
          <AiButtons big />
          <small>Connect it once. Then say <b>“{FIRST_MESSAGE}”</b> in any new chat. Free, no sign-up.</small>
          <div className="in-others"><a href="/?demo=betaflight" className="lu-link">Try the demo drone first</a><ConnectMenu others /><button className="lu-link" disabled={busy} onClick={guest}>or just look around</button></div>
        </div>
        <Scene />
      </section>
      <section className="in-steps" aria-label="How it works">
        <article><Cable size={26} /><h3>Plug in</h3><p>USB, in your browser.</p></article>
        <article><MessageSquare size={26} /><h3>Ask</h3><p>In the assistant you already use.</p></article>
        <article><MousePointerClick size={26} /><h3>Approve</h3><p>Nothing changes without your click.</p></article>
      </section>
      <section className="in-start" id="start">
        <form onSubmit={submit} className="in-form">
          <h2>{mode === 'signup' ? 'Create an account' : 'Welcome back'}</h2>
          {google && <><GoogleButton next={next ?? '/'} /><span className="gr-or">or</span></>}
          <label>Email<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label>Password<input type="password" required minLength={8} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
          {error && <p className="in-error" role="alert">{error}</p>}
          <button className="lu-btn is-primary is-big" disabled={busy}>{mode === 'signup' ? 'Create account' : 'Sign in'}</button>
          <button type="button" className="lu-link" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); }}>{mode === 'signup' ? 'I have an account' : 'Create an account'}</button>
        </form>
      </section>
      <footer className="in-foot">Open source · Apache 2.0 · You approve every change to your aircraft · <a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a></footer>
      <ClaudeSetup />
    </div>
  );
}

/** Set by “Allow” below, and read once by the consent screen it leads to, so the person clicks Allow only once. */
export const ALLOW_KEY = 'armable.allow';

/**
 * Claude's “Connect” opens this when the person isn't signed in to Armable. One button: it makes a guest bench
 * (saveable later) and allows the assistant. People with an account sign in instead.
 */
function AllowAssistant({ next, google }: { next: string; google?: boolean }) {
  const clientId = new URLSearchParams(next.split('?')[1] ?? '').get('client_id') ?? '';
  const [name, setName] = useState('Your assistant'), [signIn, setSignIn] = useState(false);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (clientId) api('GET', `/oauth-client/${encodeURIComponent(clientId)}`).then(r => setName(r.name), () => {}); }, [clientId]);
  const allow = async () => {
    setBusy(true); setError('');
    try {
      await api('POST', '/guest');
      try { sessionStorage.setItem(ALLOW_KEY, JSON.stringify({ clientId, at: Date.now() })); } catch { /* the next screen asks again */ }
      location.href = next;
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not reach Armable. Try again.'); setBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('POST', '/login', { email, password }); location.href = next; }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Could not reach Armable.'); setBusy(false); }
  };
  return (
    <div className="lu-consent">
      <div className="lu-consent-card cs-allow">
        <img src="/favicon.svg" alt="" width="34" height="34" />
        <h1>Let {name} use Armable?</h1>
        <ul>
          <li><Eye size={18} />See your drone and its settings</li>
          <li><MousePointerClick size={18} />Suggest changes. Nothing changes until you approve it in Armable.</li>
        </ul>
        {!signIn ? <>
          <button className="lu-btn is-primary is-big" data-allow disabled={busy} onClick={() => void allow()}>Allow</button>
          {error && <p className="in-error" role="alert">{error}</p>}
          <p className="lu-hint">No account needed. You can save your bench later.</p>
          <div className="lu-row"><button className="lu-link" onClick={() => setSignIn(true)}>I already have an account</button><button className="lu-link" onClick={() => { window.close(); history.back(); }}>Cancel</button></div>
        </> : <form onSubmit={submit} className="in-form">
          {google && <><GoogleButton next={next} /><span className="gr-or">or</span></>}
          <label>Email<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label>Password<input type="password" required minLength={8} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
          {error && <p className="in-error" role="alert">{error}</p>}
          <button className="lu-btn is-primary is-big" disabled={busy}>Sign in</button>
          <button type="button" className="lu-link" onClick={() => setSignIn(false)}>Back</button>
        </form>}
      </div>
    </div>
  );
}
