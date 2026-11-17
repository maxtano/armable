import type { PartId } from '../device/types';
import { select } from './controller';
import { useStore, type ProposalCard } from './store';

/**
 * The living diagram. It is drawn from the aircraft's own configuration: frame type gives the motor
 * positions and spin, and every number sits on the part it belongs to. Motion always means something:
 * things move while fresh data arrives and stop when it stops.
 */
const CX = 500, CY = 330, REACH = 215;
const cls = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(' ');
const arc = (r: number, from: number, to: number) => {
  const p = (a: number) => `${(r * Math.cos((a * Math.PI) / 180)).toFixed(1)} ${(r * Math.sin((a * Math.PI) / 180)).toFixed(1)}`;
  return `M ${p(from)} A ${r} ${r} 0 ${Math.abs(to - from) > 180 ? 1 : 0} ${to > from ? 1 : 0} ${p(to)}`;
};
/** Two curved arrows that show which way a motor turns. Drawn clockwise; mirrored for counter-clockwise. */
function SpinArrows({ r, ghost }: { r: number; ghost?: boolean }) {
  return (
    <g className={ghost ? 'dg-ghost-arrows' : 'dg-arrows'}>
      {[0, 180].map(turn => (
        <g key={turn} transform={`rotate(${turn})`}>
          <path d={arc(r, -150, -50)} fill="none" />
          <path d="M -7 -6 L 5 0 L -7 6" fill="none" transform={`rotate(-50) translate(${r} 0) rotate(90)`} />
        </g>
      ))}
    </g>
  );
}
const pendingFor = (proposals: ProposalCard[], test: (p: ProposalCard) => boolean) => proposals.find(p => p.status === 'awaiting_approval' && test(p));

export function Diagram() {
  const snap = useStore(s => s.snap), marks = useStore(s => s.marks), proposals = useStore(s => s.proposals);
  const part = useStore(s => s.part), motor = useStore(s => s.motor), settings = useStore(s => s.settings);
  const state = snap.state, connected = snap.status === 'connected', live = connected && !!state?.linkOk;
  const frame = snap.airframe;
  const motors = frame?.motors ?? [{ number: 1, x: 0.707, y: 0.707, spin: 'unknown' as const }, { number: 2, x: -0.707, y: -0.707, spin: 'unknown' as const }, { number: 3, x: -0.707, y: 0.707, spin: 'unknown' as const }, { number: 4, x: 0.707, y: -0.707, spin: 'unknown' as const }];
  const partClass = (id: PartId, extra?: string) => cls('dg-part', extra, part === id && 'is-selected', marks[id]?.kind === 'reading' && 'is-reading', marks[id]?.kind === 'changed' && 'is-changed',
    proposals.some(p => p.status === 'awaiting_approval' && (p.part === id)) && 'needs-you', !live && 'no-data');
  const pick = (id: PartId, n?: number) => (event: React.MouseEvent | React.KeyboardEvent) => { if ('key' in event && event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); select(id, n); };
  const battery = state?.battery;
  const cells = battery?.cells ?? (battery && battery.voltage > 2 ? Math.max(1, Math.round(battery.voltage / 3.9)) : 0);
  const charge = battery?.remaining !== undefined ? battery.remaining / 100 : battery && cells ? Math.min(1, Math.max(0, (battery.voltage / cells - 3.3) / 0.9)) : 0;
  const batteryTone = !battery || battery.voltage < 2 ? 'muted' : charge < 0.15 ? 'bad' : charge < 0.3 ? 'warn' : 'ok';
  const sats = state?.gps?.sats ?? 0, fix = (state?.gps?.fix ?? 0) >= 3;
  const rc = state?.rc?.channels ?? [];
  const radioOk = rc.length > 0;
  const roll = state?.attitude?.roll ?? 0, pitch = state?.attitude?.pitch ?? 0;
  const id = snap.identity;
  const blocks = state?.armingBlocks.length ?? 0;

  return (
    <svg className={cls('dg', live ? 'is-live' : 'is-still', !connected && 'is-idle')} viewBox="0 0 1000 700" data-capture="drone" role="group" aria-label={connected ? `${id?.firmware ?? 'Aircraft'} diagram` : 'No aircraft connected'}>
      <defs>
        <pattern id="dg-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" className="dg-grid-line" fill="none" /></pattern>
        <radialGradient id="dg-fade" cx="50%" cy="47%" r="60%"><stop offset="0%" stopOpacity="0" /><stop offset="100%" className="dg-fade-stop" /></radialGradient>
        <clipPath id="dg-horizon"><circle r="38" /></clipPath>
      </defs>
      <rect width="1000" height="700" fill="url(#dg-grid)" />
      <rect width="1000" height="700" fill="url(#dg-fade)" />

      {/* Connections. A pulse travels along each one while its data is fresh. */}
      <path className={cls('dg-wire', live && 'flows')} d={`M ${CX} ${CY + 62} V 548`} />
      <path className={cls('dg-wire', live && fix && 'flows', live && !fix && 'slow')} d={`M ${CX - 62} ${CY} H 214`} />
      <path className={cls('dg-wire', live && radioOk && 'flows')} d={`M ${CX + 62} ${CY} H 786`} />
      <path className={cls('dg-wire dg-usb', live && 'flows')} d={`M ${CX - 44} ${CY - 44} L 205 96 H 150`} />

      {/* Frame */}
      {motors.map(m => <line key={`arm${m.number}`} className={cls('dg-arm', !frame?.known && 'is-unknown')} x1={CX} y1={CY} x2={CX + m.x * REACH * 1.12} y2={CY - m.y * REACH} />)}
      <path className="dg-nose" d={`M ${CX - 9} ${CY - 84} L ${CX} ${CY - 100} L ${CX + 9} ${CY - 84}`} />

      {/* Motors */}
      {motors.map(m => {
        const x = CX + m.x * REACH * 1.12, y = CY - m.y * REACH;
        const pending = pendingFor(proposals, p => !!p.changes?.some(c => c.id === `esc.${m.number}.direction`) || (p.test?.id === 'motor.spin' && Number(p.test.args?.motor) === m.number));
        const output = state?.motors?.outputs[m.number - 1];
        const running = output !== undefined && output > 1020;
        const changed = marks[`esc.${m.number}.direction`]?.kind === 'changed';
        const reversed = settings.find(s => s.id === `esc.${m.number}.direction`)?.value;
        return (
          <g key={m.number} transform={`translate(${x} ${y})`} tabIndex={0} role="button" aria-label={`Motor ${m.number}${m.spin !== 'unknown' ? `, turns ${m.spin === 'cw' ? 'clockwise' : 'counter-clockwise'}` : ''}${pending ? ', change waiting for you' : ''}`}
            className={cls('dg-part dg-motor', part === 'motors' && motor === m.number && 'is-selected', (marks.motors?.kind === 'reading') && 'is-reading', changed && 'is-changed', pending && 'needs-you', !live && 'no-data', running && 'is-running')}
            onClick={pick('motors', m.number)} onKeyDown={pick('motors', m.number)} data-motor={m.number}>
            <circle className="dg-hit" r="66" />
            <circle className="dg-disc" r="50" />
            <circle className="dg-ring" r="56" />
            <circle className="dg-sweep" r="62" pathLength="100" />
            {m.spin !== 'unknown'
              ? <g className={cls('dg-spin', m.spin)}><g transform={m.spin === 'ccw' ? 'scale(-1 1)' : undefined}><SpinArrows r={38} /></g></g>
              : <text className="dg-unknown" y="-18">?</text>}
            {pending?.changes && m.spin !== 'unknown' && <g className={cls('dg-spin dg-ghost', m.spin === 'cw' ? 'ccw' : 'cw')}><g transform={m.spin === 'cw' ? 'scale(-1 1)' : undefined}><SpinArrows r={47} ghost /></g></g>}
            <circle className="dg-hub" r="15" />
            <text className="dg-num" y="5">{m.number}</text>
            {typeof reversed === 'string' && reversed !== 'normal' && <text className="dg-tag" y="82">{reversed === 'reversed' ? 'Reversed' : 'Both ways'}</text>}
            {changed && <circle className="dg-dot" cx="42" cy="-42" r="5" />}
            {pending && <g className="dg-approve" transform="translate(0 -78)"><rect x="-44" y="-14" width="88" height="28" rx="14" /><text y="5">{pending.level === 3 ? 'Start' : 'Approve'}</text></g>}
          </g>
        );
      })}

      {/* Flight controller. The horizon inside tilts as the real one does. */}
      <g transform={`translate(${CX} ${CY})`} tabIndex={0} role="button" aria-label={`Flight controller${id ? `, ${id.firmware} ${id.version}` : ''}`} className={partClass('fc', 'dg-fc')} onClick={pick('fc')} onKeyDown={pick('fc')}>
        <rect className="dg-hit" x="-76" y="-76" width="152" height="152" rx="14" />
        <rect className="dg-plate" x="-62" y="-62" width="124" height="124" rx="10" />
        <circle className="dg-sweep" r="80" pathLength="100" />
        <g clipPath="url(#dg-horizon)">
          <g transform={`rotate(${-roll}) translate(0 ${Math.max(-30, Math.min(30, pitch * 1.2))})`} className="dg-tilt">
            <rect className="dg-sky" x="-80" y="-120" width="160" height="120" />
            <rect className="dg-ground" x="-80" y="0" width="160" height="120" />
            <line className="dg-horizon-line" x1="-80" x2="80" />
          </g>
          <path className="dg-wings" d="M -24 0 H -9 M 9 0 H 24 M 0 -3 V 3" />
        </g>
        <circle className="dg-bezel" r="38" />
        {state?.armed && <text className="dg-armed" y="-74">ARMED</text>}
        {marks.fc?.kind === 'changed' && <circle className="dg-dot" cx="56" cy="-56" r="5" />}
      </g>
      {connected && blocks > 0 && (
        <g transform={`translate(${CX + 108} ${CY - 88})`} tabIndex={0} role="button" aria-label={`Will not arm, ${blocks} reason${blocks > 1 ? 's' : ''}`} className={partClass('safety', 'dg-chip is-warn')} onClick={pick('safety')} onKeyDown={pick('safety')}>
          <rect x="-46" y="-13" width="92" height="26" rx="13" /><text y="4.5">Won't arm · {blocks}</text>
        </g>
      )}

      {/* Battery */}
      <g transform={`translate(${CX} 590)`} tabIndex={0} role="button" aria-label={battery ? `Battery, ${battery.voltage.toFixed(1)} volts` : 'Battery, no reading'} className={partClass('battery', `dg-battery tone-${batteryTone}`)} onClick={pick('battery')} onKeyDown={pick('battery')}>
        <rect className="dg-hit" x="-110" y="-46" width="220" height="92" rx="12" />
        <rect className="dg-cell" x="-78" y="-26" width="150" height="52" rx="7" />
        <rect className="dg-cell-tip" x="74" y="-10" width="8" height="20" rx="2" />
        <rect className="dg-charge" x="-72" y="-20" width={Math.max(0, 138 * charge)} height="40" rx="4" />
        <circle className="dg-sweep" r="96" pathLength="100" />
        <text className="dg-value" y="6">{battery && battery.voltage >= 2 ? `${battery.voltage.toFixed(1)} V` : connected ? 'USB only' : '—'}</text>
        <text className="dg-label" y="50">{cells ? `Battery · ${cells}S` : 'Battery'}</text>
        {marks.battery?.kind === 'changed' && <circle className="dg-dot" cx="86" cy="-34" r="5" />}
      </g>

      {/* GPS: the ring closes as satellites arrive. */}
      <g transform={`translate(160 ${CY})`} tabIndex={0} role="button" aria-label={`GPS, ${sats} satellites${fix ? ', fix' : ', no fix'}`} className={partClass('gps', cls('dg-gps', fix ? 'tone-ok' : 'tone-muted'))} onClick={pick('gps')} onKeyDown={pick('gps')}>
        <circle className="dg-hit" r="66" />
        <circle className="dg-track" r="44" />
        <circle className="dg-progress" r="44" pathLength="100" strokeDasharray={`${Math.min(100, (sats / 14) * 100)} 100`} transform="rotate(-90)" />
        <circle className="dg-sweep" r="56" pathLength="100" />
        <text className="dg-value" y="7">{state?.gps ? sats : '—'}</text>
        <text className="dg-label" y="72">GPS</text>
      </g>

      {/* Receiver: bars for signal, four small bars for the sticks. */}
      <g transform={`translate(840 ${CY})`} tabIndex={0} role="button" aria-label={radioOk ? `Radio, ${rc.length} channels` : 'Radio, no signal'} className={partClass('receiver', cls('dg-radio', radioOk ? 'tone-ok' : connected ? 'tone-bad' : 'tone-muted'))} onClick={pick('receiver')} onKeyDown={pick('receiver')}>
        <circle className="dg-hit" r="66" />
        <circle className="dg-track" r="50" />
        <circle className="dg-sweep" r="58" pathLength="100" />
        {[0, 1, 2, 3].map(i => {
          const value = rc[i] ?? 1500, h = radioOk ? 6 + ((Math.min(2000, Math.max(1000, value)) - 1000) / 1000) * 34 : 6;
          return <rect key={i} className="dg-stick" x={-27 + i * 15} y={20 - h} width="9" height={h} rx="2" />;
        })}
        {!radioOk && connected && <path className="dg-cross" d="M -12 -28 L 12 -4 M 12 -28 L -12 -4" />}
        <text className="dg-label" y="76">Radio</text>
        {marks.receiver?.kind === 'changed' && <circle className="dg-dot" cx="42" cy="-42" r="5" />}
      </g>

      {/* The cable to this computer. */}
      <g transform="translate(118 96)" tabIndex={0} role="button" aria-label={live ? 'Connected' : 'Not connected'} className={partClass('link', cls('dg-link', live ? 'tone-ok' : 'tone-muted'))} onClick={pick('link')} onKeyDown={pick('link')}>
        <rect className="dg-hit" x="-56" y="-34" width="112" height="78" rx="10" />
        <rect className="dg-plug" x="-30" y="-14" width="52" height="28" rx="5" />
        <path className="dg-plug-pins" d="M -16 -5 V 5 M -6 -5 V 5 M 4 -5 V 5" />
        <text className="dg-label" y="38">{snap.demo ? 'Demo' : 'USB'}</text>
      </g>

      {connected && id && <text className="dg-caption" x={CX} y="668">{[id.craftName, `${id.firmware} ${id.version}`, frame?.label].filter(Boolean).join('  ·  ')}</text>}
    </svg>
  );
}
