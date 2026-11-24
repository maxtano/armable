import { useEffect, useState } from 'react';
import { Layers3, Wrench } from 'lucide-react';
import { api, Live } from '../platform/cloud';
import { ShowLibrary } from './library';

/**
 * Armable Shows: the drone-show studio, on its own. It shares the account, the document store and the design
 * system with the Armable bench, and nothing of its interface — nobody reaches a timeline by way of a flight
 * controller, and nobody configuring an aircraft is shown choreography.
 */
interface Me { signedIn: boolean; offline?: boolean; email?: string }

const HERE = '/show';

export function App() {
  const [me, setMe] = useState<Me>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    void (async () => { try { setMe(await api<Me>('GET', '/me')); } catch { setMe({ signedIn: false, offline: true }); } })();
  }, []);
  useEffect(() => {
    if (!me?.signedIn) return;
    // One socket, only to hear that a storyboard changed. Requests about the aircraft go to a bench tab.
    const live = new Live('show', message => { if (message.type === 'event' && message.event === 'document') setRevision(r => r + 1); }, () => {});
    live.open();
    return () => live.close();
  }, [me?.signedIn]);
  if (!me) return <div className="boot" role="status" aria-label="Loading Armable Shows"><div>Armable Shows<i /></div></div>;
  if (!me.signedIn) return <SignIn offline={me.offline} />;
  return <ShowLibrary revision={revision} onLeaveToBench={() => location.assign('/')} />;
}

/** Shows and the bench are one account, so signing in happens once, on the Armable page, and comes back here. */
function SignIn({ offline }: { offline?: boolean }) {
  return (
    <div className="sh-gate">
      <div className="sh-gate-card">
        <span className="sh-gate-mark"><Layers3 size={22} aria-hidden /></span>
        <h1>Armable Shows</h1>
        <p>Design a drone show: formations, keyframes, transitions, and what the audience sees from where they stand.</p>
        {offline
          ? <p className="sh-gate-error" role="alert">Armable can’t be reached right now. Your storyboards are in your account, so they will be here when it is back.</p>
          : <a className="ds-button" data-variant="primary" data-size="lg" href={`/?next=${encodeURIComponent(HERE)}`}>Sign in to Armable</a>}
        <a className="sh-gate-aside" href="/"><Wrench size={14} aria-hidden /> Configuring a drone instead? Open the Armable bench</a>
      </div>
    </div>
  );
}
