import { useEffect, useRef } from 'react';
import { flyQuad } from './quad';

/**
 * The panel before there is a drone to show. It is the only screen most people meet first, so
 * it has one job beyond the two buttons: say what this strip of the window is. A dark slab
 * against a light conversation reads as an instrument rather than as more of the page, and the
 * craft flying in it says "drone" before anyone reads a word.
 *
 * The same quad flies on armable.ai, drawn by the same code.
 */
export function Welcome({ busy, onDemo, onPlug }: { busy: string; onDemo: () => void; onPlug: () => void }) {
  const sky = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!sky.current) return;
    const quad = flyQuad(sky.current);
    return () => quad.stop();
  }, []);

  return (
    <section className="pn-welcome stage">
      <div className="pn-sky">
        <pre className="pn-quad" ref={sky} aria-hidden />
        <span className="pn-tag"><i />Standing by</span>
      </div>
      <div className="pn-pitch">
        <h1>Armable is ready</h1>
        <p className="pn-lead">Your drone, live, beside the chat.</p>
        <ol className="pn-steps">
          <li>You ask on the left.</li>
          <li>It answers here.</li>
          <li>Nothing changes until you approve it.</li>
        </ol>
      </div>
      <div className="pn-actions">
        <button className="lu-btn is-primary is-big" data-panel="demo" disabled={!!busy} onClick={onDemo}>{busy || 'Try the demo drone'}</button>
        <button className="lu-btn is-big" data-panel="plug" onClick={onPlug}>Plug in your drone</button>
      </div>
      <p className="pn-note">Plugging in a real drone opens Armable in your browser — Chrome or Edge, props off.</p>
    </section>
  );
}
