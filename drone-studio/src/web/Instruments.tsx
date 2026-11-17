/**
 * Instruments in the spirit of a good radio: a round dial with plain ticks and one orange needle, an
 * indicator lamp, and a copper coil. Nothing here carries logic; they show a number and get out of the way.
 */

const polar = (deg: number, r: number, c = 60) => { const a = (deg - 90) * Math.PI / 180; return [c + Math.cos(a) * r, c + Math.sin(a) * r] as const; };
const SWEEP = 270, START = -135;

export interface DialProps {
  label: string;
  /** What the face says, e.g. "485 g". */
  reading: string;
  value?: number; min?: number; max: number;
  /** Small marks with a word, such as the 250 g line. */
  marks?: { at: number; label: string }[];
  /** The part of the scale to colour as a caution. */
  caution?: [number, number];
  note?: string;
  tone?: 'ok' | 'warn' | 'bad';
  size?: number;
}

export function Dial({ label, reading, value, min = 0, max, marks = [], caution, note, tone, size = 132 }: DialProps) {
  const at = (v: number) => START + SWEEP * Math.max(0, Math.min(1, (v - min) / (max - min)));
  const known = value !== undefined && Number.isFinite(value);
  const needle = at(known ? value! : min);
  const arc = (from: number, to: number, r: number) => { const [x1, y1] = polar(at(from), r), [x2, y2] = polar(at(to), r); return `M ${x1} ${y1} A ${r} ${r} 0 ${at(to) - at(from) > 180 ? 1 : 0} 1 ${x2} ${y2}`; };
  return (
    <figure className={`in-dial${tone ? ` is-${tone}` : ''}${known ? '' : ' is-empty'}`} style={{ width: size }}>
      <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label={`${label}: ${reading}`}>
        <circle className="in-dial-bezel" cx="60" cy="60" r="57" />
        <circle className="in-dial-face" cx="60" cy="60" r="51" />
        {caution && <path className="in-dial-caution" d={arc(caution[0], caution[1], 44)} />}
        {Array.from({ length: 41 }, (_, i) => { const deg = START + (SWEEP / 40) * i, major = i % 10 === 0; const [x1, y1] = polar(deg, major ? 38 : 41), [x2, y2] = polar(deg, 46); return <line key={i} className={major ? 'in-dial-major' : 'in-dial-minor'} x1={x1} y1={y1} x2={x2} y2={y2} />; })}
        {marks.map(m => { const [x1, y1] = polar(at(m.at), 34), [x2, y2] = polar(at(m.at), 47); return <line key={m.label} className="in-dial-mark" x1={x1} y1={y1} x2={x2} y2={y2} />; })}
        <text className="in-dial-reading" x="60" y="88" textAnchor="middle">{reading}</text>
        <g className="in-dial-needle" style={{ transform: `rotate(${needle}deg)` }}><line x1="60" y1="66" x2="60" y2="20" /></g>
        <circle className="in-dial-cap" cx="60" cy="60" r="6" />
        <circle className="in-dial-cap-hi" cx="58.5" cy="58.5" r="2" />
      </svg>
      <figcaption><b>{label}</b>{note && <small>{note}</small>}</figcaption>
    </figure>
  );
}

/** An indicator lamp: on, off, or amber. */
export function Lamp({ on = true, tone = 'ok', label }: { on?: boolean; tone?: 'ok' | 'warn' | 'bad'; label?: string }) {
  return <span className={`in-lamp is-${tone}${on ? ' is-on' : ''}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/** A copper coil wound on a core, drawn left to right. Decoration only. */
export function Coil({ turns = 9, width = 160, height = 44, className = '' }: { turns?: number; width?: number; height?: number; className?: string }) {
  const pad = 14, step = (width - pad * 2) / turns, cy = height / 2, ry = height / 2 - 6;
  return (
    <svg className={`in-coil ${className}`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden>
      <rect className="in-coil-core" x="2" y={cy - 5} width={width - 4} height="10" rx="5" />
      {Array.from({ length: turns }, (_, i) => { const x = pad + step * (i + 0.5), rx = step * 0.36; return <g key={i} transform={`rotate(-14 ${x} ${cy})`}>
        <ellipse className="in-coil-back" cx={x} cy={cy} rx={rx} ry={ry} />
        <path className="in-coil-front" d={`M ${x} ${cy - ry} A ${rx} ${ry} 0 0 1 ${x} ${cy + ry}`} />
      </g>; })}
      <path className="in-coil-lead" d={`M ${pad - 2} ${cy - ry} q -8 -4 -12 4`} /><path className="in-coil-lead" d={`M ${width - pad + 2} ${cy - ry} q 8 -4 12 4`} />
    </svg>
  );
}
