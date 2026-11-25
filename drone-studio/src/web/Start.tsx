import { useEffect, useState } from 'react';
import { Eye, MousePointerClick } from 'lucide-react';
import { api, ApiError } from './cloud';
import { AiButtons, ClaudeSetup, FIRST_MESSAGE } from './ClaudeSetup';
import { ConnectMenu } from './ConnectMenu';
import { GoogleButton, tryAsGuest } from './Growth';

/**
 * The doorway, and deliberately not a second home page: armable.ai already makes the case for the product, and
 * two pages making it were two places to keep in step. This screen has one job, which is to get whoever clicked
 * “Open Armable” into the bench. So it asks the only question that changes anything -- which assistant -- and
 * gives anyone without a drone to plug in a demo bench instead of a reason to leave.
 */
export function Start({ onSignedIn, google }: { onSignedIn(): void; google?: boolean }) {
  const params = new URLSearchParams(location.search), next = params.get('next');
  // An assistant app sent the person here to allow it: one screen, one button, nothing else on it.
  if (next?.startsWith('/authorize')) return <AllowAssistant next={next} google={google} />;
  return <Doorway onSignedIn={onSignedIn} google={google} next={next} failed={params.get('signin') ?? ''} />;
}

/** Connect an assistant, open a demo bench, or sign back in. The form stays folded away until it is asked for. */
function Doorway({ onSignedIn, google, next, failed }: { onSignedIn(): void; google?: boolean; next: string | null; failed: string }) {
  // A sign-in that failed elsewhere (Google, say) comes back with its reason, so open straight to the form.
  const [form, setForm] = useState(!!failed), [mode, setMode] = useState<'signup' | 'login'>('login');
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [error, setError] = useState(failed), [busy, setBusy] = useState(false);
  const guest = async () => {
    setBusy(true);
    try { await tryAsGuest(next); } catch { setError('Could not start right now. Try again.'); setBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api('POST', mode === 'signup' ? '/signup' : '/login', { email, password });
      // An assistant app sent them here to sign in first: carry on with that request.
      if (next?.startsWith('/authorize')) location.href = next; else onSignedIn();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not reach Armable.'); setBusy(false); }
  };
  return (
    <div className="st">
      <div className="st-card">
        <span className="in-logo"><img src="/favicon.svg" alt="" width="22" height="22" />Armable</span>
        {form ? (
          <form onSubmit={submit} className="in-form st-form">
            <h2>{mode === 'signup' ? 'Create an account' : 'Welcome back'}</h2>
            {google && <><GoogleButton next={next ?? '/'} /><span className="gr-or">or</span></>}
            <label>Email<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
            <label>Password<input type="password" required minLength={8} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>
            {error && <p className="in-error" role="alert">{error}</p>}
            <button className="lu-btn is-primary is-big" disabled={busy}>{mode === 'signup' ? 'Create account' : 'Sign in'}</button>
            <button type="button" className="lu-link" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setError(''); }}>{mode === 'signup' ? 'I have an account' : 'Create an account'}</button>
            <button type="button" className="lu-link" onClick={() => { setForm(false); setError(''); }}>Back</button>
          </form>
        ) : <>
          <h1>Connect your AI</h1>
          <p>Armable is the hands. Your assistant is the brain, and it is the one you already pay for. Connect it once, then say <b>“{FIRST_MESSAGE}”</b> in any new chat.</p>
          <AiButtons big />
          <ConnectMenu others />
          {error && <p className="in-error" role="alert">{error}</p>}
          <hr />
          <div className="st-rest">
            <a className="lu-link" href="/?demo=betaflight">No drone yet? Open the demo bench</a>
            <button className="lu-link" disabled={busy} onClick={() => void guest()}>or just look around</button>
            <button className="lu-link" onClick={() => setForm(true)}>Sign in</button>
          </div>
        </>}
      </div>
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
