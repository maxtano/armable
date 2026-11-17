import { useEffect, useState } from 'react';
import { Cable, MessageSquare, MousePointerClick } from 'lucide-react';
import { api, ApiError } from './cloud';
import { ConnectMenu } from './ConnectMenu';
import { Stator } from './Diagram';
import { Coil } from './Instruments';

/**
 * The intro page. One picture explains the product: you say it, the assistant proposes it on the drone,
 * you approve, the drone changes. The picture plays on a loop; with reduced motion it rests on the last frame.
 */
const PHASES = ['say', 'look', 'propose', 'approve', 'done'] as const;
function Scene() {
  const still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [phase, setPhase] = useState(still ? 4 : 0);
  useEffect(() => {
    if (still) return;
    const times = [2200, 1600, 2200, 1300, 3200];
    const t = setTimeout(() => setPhase((phase + 1) % PHASES.length), times[phase]);
    return () => clearTimeout(t);
  }, [phase, still]);
  const p = PHASES[phase];
  const motors: [number, number, number, 'cw' | 'ccw'][] = [[1, 300, 96, 'ccw'], [2, 96, 250, 'ccw'], [3, 96, 96, 'cw'], [4, 300, 250, 'cw']];
  const flipped = p === 'done';
  return (
    <div className={`in-scene is-${p}`} aria-hidden>
      <svg viewBox="0 0 396 346" className="in-drone">
        <defs><pattern id="in-grid" width="33" height="33" patternUnits="userSpaceOnUse"><path d="M 33 0 L 0 0 0 33" className="dg-grid-line" fill="none" /></pattern></defs>
        <rect width="396" height="346" fill="url(#in-grid)" rx="6" />
        {motors.map(([n, x, y]) => <line key={n} className="dg-arm" x1="198" y1="173" x2={x} y2={y} />)}
        <rect className="dg-plate" x="166" y="141" width="64" height="64" rx="8" />
        <circle className="dg-bezel" cx="198" cy="173" r="18" />
        <line className="dg-horizon-line" x1="184" x2="212" y1="173" y2="173" />
        {motors.map(([n, x, y, spin]) => {
          const wrong = n === 3 && !flipped;
          const turn = n === 3 ? (flipped ? 'cw' : 'ccw') : spin;
          return (
            <g key={n} transform={`translate(${x} ${y})`} className={`dg-part dg-motor${n === 3 && p === 'look' ? ' is-reading' : ''}${n === 3 && (p === 'propose' || p === 'approve') ? ' needs-you' : ''}${n === 3 && flipped ? ' is-changed' : ''}${wrong && p !== 'say' ? ' is-wrong' : ''}`}>
              <circle className="dg-disc" r="38" /><Stator r={19} /><circle className="dg-ring" r="43" /><circle className="dg-sweep" r="48" pathLength="100" />
              <g className={`dg-spin ${turn}`}><g transform={turn === 'ccw' ? 'scale(-1 1)' : undefined}><g className="dg-arrows">{[0, 180].map(a => <g key={a} transform={`rotate(${a})`}><path d="M -25.1 -14.5 A 29 29 0 0 1 18.6 -22.2" fill="none" /><path d="M -6 -5 L 4 0 L -6 5" fill="none" transform="rotate(-50) translate(29 0) rotate(90)" /></g>)}</g></g></g>
              {n === 3 && (p === 'propose' || p === 'approve') && <g className="dg-spin dg-ghost cw"><g className="dg-ghost-arrows">{[0, 180].map(a => <g key={a} transform={`rotate(${a})`}><path d="M -31.2 -18 A 36 36 0 0 1 23.1 -27.6" fill="none" /></g>)}</g></g>}
              <circle className="dg-hub" r="11" /><text className="dg-num" y="4">{n}</text>
              {n === 3 && flipped && <circle className="dg-dot" cx="32" cy="-32" r="4.5" />}
              {n === 3 && (p === 'propose' || p === 'approve') && <g className={`dg-approve${p === 'approve' ? ' is-pressed' : ''}`} transform="translate(0 -62)"><rect x="-40" y="-13" width="80" height="26" rx="13" /><text y="4.5">Approve</text></g>}
            </g>
          );
        })}
      </svg>
      <div className="in-chat">
        <p className="in-you">Motor 3 spins backwards. Fix it.</p>
        <p className={`in-ai${phase >= 2 ? ' is-in' : ''}`}>{flipped ? 'Done. Motor 3 turns the right way now.' : 'I can reverse it. Approve it on the drone.'}</p>
      </div>
    </div>
  );
}

export function Landing({ onSignedIn }: { onSignedIn(): void }) {
  const [mode, setMode] = useState<'signup' | 'login'>('signup'), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const next = new URLSearchParams(location.search).get('next');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api('POST', mode === 'signup' ? '/signup' : '/login', { email, password });
      // An assistant app sent them here to sign in first: carry on with that request.
      if (next?.startsWith('/authorize')) location.href = next; else onSignedIn();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not reach Lucidity.'); setBusy(false); }
  };
  return (
    <div className="in">
      <header className="in-top"><span className="in-logo"><img src="/favicon.svg" alt="" width="22" height="22" />Lucidity</span><a href="#start" className="lu-btn">Sign in</a></header>
      <section className="in-hero">
        <div className="in-copy">
          <Coil width={150} height={38} />
          <h1>Your drone.<br />Your AI.<br /><em>One bench.</em></h1>
          <p>Plug in your drone. Tell Claude or ChatGPT what’s wrong. Watch the fix happen.</p>
          <div className="in-actions">
            <a href="#start" className="lu-btn is-primary is-big">{next ? 'Sign in to connect' : 'Get started'}</a>
            {!next && <ConnectMenu big />}
          </div>
          <small>No install. No API key. Works with Betaflight, ArduPilot and PX4.</small>
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
          <h2>{mode === 'signup' ? 'Create your bench' : 'Welcome back'}</h2>
          <label>Email<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
          <label>Password<input type="password" required minLength={8} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
          {error && <p className="in-error" role="alert">{error}</p>}
          <button className="lu-btn is-primary is-big" disabled={busy}>{mode === 'signup' ? 'Create account' : 'Sign in'}</button>
          <button type="button" className="lu-link" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); }}>{mode === 'signup' ? 'I have an account' : 'Create an account'}</button>
        </form>
      </section>
      <footer className="in-foot">Open source · Apache 2.0 · You approve every change to your aircraft · <a href="/privacy.html">Privacy</a></footer>
    </div>
  );
}
