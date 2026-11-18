import type { ReactNode } from 'react';
import type { Category, Specs } from '../build/catalog';

/**
 * A drawing of a part, made from what Armable knows about it: a 7" frame has long arms, a 1404 motor is small,
 * a 5-blade prop has five blades, a 6S pack says 6S. Colours come from the theme; the accent follows the brand.
 */
export interface Drawable { id?: string; category: Category; brand?: string; name: string; specs?: Specs }

const hue = (brand = '') => { let h = 0; for (const c of brand) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 5; };
const ring = (n: number, r: number, cx = 60, cy = 60) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2 - Math.PI / 4; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const; });

export function PartArt({ part, size = 56, className = '' }: { part: Drawable; size?: number; className?: string }) {
  return (
    <svg className={`pa pa-h${hue(part.brand)} ${className}`} viewBox="0 0 120 120" width={size} height={size} role="img" aria-label={`Drawing of ${part.brand ?? ''} ${part.name}`.trim()}>
      <rect className="pa-bg" x="0" y="0" width="120" height="120" rx="12" />
      {draw(part)}
    </svg>
  );
}

function draw(p: Drawable): ReactNode {
  const s = p.specs ?? {}, name = p.name.toLowerCase(), id = p.id ?? '';
  switch (p.category) {
    case 'frame': {
      if (s.ducted) {
        const d = ring(4, 30), r = (s.propIn ?? 3) < 2 ? 18 : 21;
        return <>
          {d.map(([x, y], i) => <g key={i}><circle className="pa-b" cx={x} cy={y} r={r + 4} /><circle className="pa-d" cx={x} cy={y} r={r} /><circle className="pa-m" cx={x} cy={y} r={3} /></g>)}
          <rect className="pa-a" x="44" y="40" width="32" height="40" rx="7" />
          <circle className="pa-d" cx="60" cy="46" r="4" />
        </>;
      }
      const len = Math.min(50, 26 + (s.propIn ?? 5) * 3.4), arms = ring(4, len);
      return <>
        {arms.map(([x, y], i) => <circle key={`p${i}`} className="pa-disc" cx={x} cy={y} r={Math.min(22, 5 + (s.propIn ?? 5) * 2.4)} />)}
        <line className="pa-arm" x1={arms[0][0]} y1={arms[0][1]} x2={arms[2][0]} y2={arms[2][1]} />
        <line className="pa-arm" x1={arms[1][0]} y1={arms[1][1]} x2={arms[3][0]} y2={arms[3][1]} />
        {arms.map(([x, y], i) => <circle key={`m${i}`} className="pa-m" cx={x} cy={y} r="4.5" />)}
        <rect className="pa-a" x="44" y="38" width="32" height="44" rx="5" />
        {[[47, 41], [73, 41], [47, 79], [73, 79]].map(([x, y], i) => <circle key={i} className="pa-d" cx={x} cy={y} r="2" />)}
      </>;
    }
    case 'motors': {
      const w = Math.max(30, Math.min(70, Number((s.stator ?? '22').slice(0, 2)) * 2.4)), h = Math.max(26, Math.min(44, Number((s.stator ?? '2207').slice(2, 4)) * 4.4)), x = 60 - w / 2, top = 70 - h / 2;
      return <>
        <rect className="pa-b" x={x - 4} y={top + h - 4} width={w + 8} height="12" rx="3" />
        {Array.from({ length: 6 }, (_, i) => <rect key={`c${i}`} className="pa-cu" x={x + 2 + i * (w - 4) / 6} y={top + h - 8} width={(w - 4) / 6 - 1.5} height="8" rx="1.5" />)}
        <rect className="pa-a" x={x} y={top} width={w} height={h} rx="4" />
        {[0.2, 0.45, 0.7].map(f => <rect key={f} className="pa-d" x={x + w * f} y={top + 6} width={w * 0.12} height={h * 0.45} rx="1.5" />)}
        <ellipse className="pa-hi" cx="60" cy={top} rx={w / 2} ry="5" />
        <rect className="pa-m" x="56" y={top - 16} width="8" height="16" rx="2" />
        <path className="pa-wire" d={`M ${60 - 6} ${top + h + 8} q -4 14 -16 22 M 60 ${top + h + 8} q 0 14 -10 24 M ${60 + 6} ${top + h + 8} q 4 14 -2 24`} />
        {s.kv ? <text className="pa-t" x="60" y={top + h - 6} textAnchor="middle">{s.kv}</text> : null}
      </>;
    }
    case 'stack': {
      const aio = s.mounts?.[0] === 'whoop', size = aio ? 44 : s.mounts?.[0] === '20' ? 52 : 64, x = 60 - size / 2;
      const board = (y: number, cls: string, chip: boolean) => <g>
        <rect className={cls} x={x} y={y} width={size} height={size * 0.62} rx="5" />
        {[[x + 6, y + 6], [x + size - 6, y + 6], [x + 6, y + size * 0.62 - 6], [x + size - 6, y + size * 0.62 - 6]].map(([a, b], i) => <circle key={i} className="pa-bg" cx={a} cy={b} r="2.6" />)}
        {chip && <rect className="pa-d" x={60 - size * 0.16} y={y + size * 0.14} width={size * 0.32} height={size * 0.32} rx="2" />}
      </g>;
      return <>
        {!aio && board(64, 'pa-b', false)}
        {!aio && [0.2, 0.4, 0.6, 0.8].map(f => <rect key={f} className="pa-d" x={x + size * f - 4} y="70" width="8" height="8" rx="1" />)}
        {board(aio ? 42 : 30, 'pa-a', true)}
        <text className="pa-t" x="60" y={(aio ? 42 : 30) + size * 0.62 + 12} textAnchor="middle">{/f7/.test(name) ? 'F7' : 'F4'}</text>
      </>;
    }
    case 'props': {
      const n = s.blades ?? 3, r = 46;
      return <>
        {Array.from({ length: n }, (_, i) => <ellipse key={i} className="pa-blade" cx="60" cy={60 - r / 2} rx={n > 3 ? 7 : 9} ry={r / 2} transform={`rotate(${(360 / n) * i + 12} 60 60)`} />)}
        <circle className="pa-b" cx="60" cy="60" r="10" />
        <circle className="pa-d" cx="60" cy="60" r="4" />
        <text className="pa-t pa-corner" x="10" y="112">{s.propIn}"</text>
      </>;
    }
    case 'battery': {
      if (s.chem === 'Li-ion') return <>
        {Array.from({ length: Math.min(6, s.series ?? 6) }, (_, i) => <g key={i}><rect className="pa-a" x={18 + i * 15} y="30" width="13" height="56" rx="6" /><rect className="pa-hi" x={21 + i * 15} y="33" width="3" height="48" rx="1.5" /></g>)}
        <rect className="pa-b" x="14" y="52" width="96" height="12" rx="2" />
        <text className="pa-t" x="62" y="61" textAnchor="middle">{s.series}S {s.mah}</text>
        <path className="pa-wire" d="M 14 58 q -6 18 6 32" /><rect className="pa-plug" x="14" y="88" width="16" height="10" rx="2" />
      </>;
      const small = (s.series ?? 4) <= 1;
      return <>
        <rect className="pa-b" x={small ? 38 : 22} y={small ? 26 : 32} width={small ? 44 : 78} height={small ? 66 : 52} rx="6" />
        <rect className="pa-a" x={small ? 38 : 22} y={small ? 46 : 46} width={small ? 44 : 78} height={small ? 22 : 22} />
        <text className="pa-t pa-big" x={small ? 60 : 61} y={small ? 62 : 62} textAnchor="middle">{s.series}S</text>
        <text className="pa-t" x="60" y={small ? 104 : 98} textAnchor="middle">{s.mah} mAh</text>
        {!small && <><path className="pa-wire" d="M 100 44 q 14 0 12 -16" /><rect className="pa-plug" x="104" y="16" width="12" height="14" rx="2" /></>}
      </>;
    }
    case 'receiver': {
      const two = s.diversity || /diversity|td/.test(name);
      return <>
        <rect className="pa-a" x="44" y="58" width="32" height="22" rx="3" />
        <rect className="pa-d" x="52" y="63" width="10" height="10" rx="1" />
        <circle className="pa-led" cx="70" cy="64" r="2.5" />
        <path className="pa-wire" d="M 52 58 C 46 40 32 34 22 20" /><rect className="pa-m" x="16" y="12" width="12" height="4" rx="2" transform="rotate(-50 22 14)" />
        {two && <><path className="pa-wire" d="M 68 58 C 74 40 88 34 98 20" /><rect className="pa-m" x="92" y="12" width="12" height="4" rx="2" transform="rotate(50 98 14)" /></>}
        <path className="pa-wire" d="M 54 80 q 0 14 -10 22 M 60 80 q 0 14 0 22 M 66 80 q 0 14 10 22" />
      </>;
    }
    case 'vtx': {
      if (s.includes?.includes('camera')) return <>
        <rect className="pa-b" x="46" y="44" width="58" height="44" rx="6" />
        {[0, 1, 2, 3].map(i => <rect key={i} className="pa-d" x={54 + i * 11} y="54" width="6" height="24" rx="3" />)}
        <rect className="pa-a" x="16" y="42" width="34" height="34" rx="6" />
        <circle className="pa-d" cx="33" cy="59" r="11" /><circle className="pa-lens" cx="33" cy="59" r="6" />
        <path className="pa-wire" d="M 96 44 q 4 -16 12 -24 M 86 44 q 0 -18 -6 -28" />
        <text className="pa-t pa-corner" x="10" y="112">{s.video === 'dji' ? 'DJI' : s.video === 'walksnail' ? 'Walksnail' : 'HD'}</text>
      </>;
      return <>
        <rect className="pa-a" x="34" y="44" width="52" height="34" rx="4" />
        <rect className="pa-d" x="42" y="52" width="16" height="16" rx="2" />
        <circle className="pa-led" cx="78" cy="52" r="2.5" />
        <rect className="pa-m" x="84" y="54" width="10" height="10" rx="2" />
        {s.includes?.includes('antenna') && <path className="pa-wire" d="M 94 59 q 14 0 18 -26" />}
        <text className="pa-t pa-corner" x="10" y="112">5.8G</text>
      </>;
    }
    case 'camera': return <>
      <rect className="pa-a" x="30" y="30" width="60" height="60" rx="10" />
      <circle className="pa-d" cx="60" cy="60" r="22" /><circle className="pa-b" cx="60" cy="60" r="15" /><circle className="pa-lens" cx="60" cy="60" r="8" />
      <rect className="pa-m" x="22" y="52" width="8" height="16" rx="2" /><rect className="pa-m" x="90" y="52" width="8" height="16" rx="2" />
    </>;
    case 'antenna': {
      const lolly = /lollipop/.test(name);
      return <>
        <path className="pa-wire is-thick" d="M 60 108 L 60 62" />
        <rect className="pa-m" x="54" y="96" width="12" height="12" rx="2" />
        {lolly ? <><circle className="pa-a" cx="60" cy="40" r="22" /><circle className="pa-hi" cx="52" cy="32" r="5" /></> : <rect className="pa-a" x="50" y="24" width="20" height="44" rx="10" />}
      </>;
    }
    case 'gps': return <>
      <rect className="pa-b" x="28" y="28" width="64" height="64" rx="6" />
      <rect className="pa-a" x="38" y="38" width="44" height="44" rx="4" />
      <circle className="pa-d" cx="60" cy="60" r="5" />
      <path className="pa-wire" d="M 60 92 q 0 12 -14 20 M 66 92 q 2 12 10 20" />
      <text className="pa-t pa-corner" x="10" y="22">GPS</text>
    </>;
    case 'radio': return <>
      <path className="pa-b" d="M 14 52 Q 14 34 32 34 L 88 34 Q 106 34 106 52 L 110 86 Q 112 100 98 100 L 22 100 Q 8 100 10 86 Z" />
      {[38, 82].map(x => <g key={x}><circle className="pa-d" cx={x} cy="62" r="13" /><circle className="pa-m" cx={x} cy="62" r="4" /><line className="pa-wire is-thick" x1={x} y1="62" x2={x + 2} y2="50" /></g>)}
      <rect className="pa-a" x="50" y="42" width="20" height="12" rx="2" />
      <rect className="pa-m" x="84" y="12" width="6" height="24" rx="3" transform="rotate(15 87 24)" />
    </>;
    case 'goggles': return <>
      <path className="pa-wire is-strap" d="M 12 60 Q 60 30 108 60" />
      <path className="pa-a" d="M 16 46 Q 16 36 28 36 L 92 36 Q 104 36 104 46 L 104 74 Q 104 86 92 86 L 70 86 Q 60 76 50 86 L 28 86 Q 16 86 16 74 Z" />
      <circle className="pa-d" cx="40" cy="60" r="13" /><circle className="pa-d" cx="80" cy="60" r="13" />
      <circle className="pa-hi" cx="36" cy="56" r="3" /><circle className="pa-hi" cx="76" cy="56" r="3" />
    </>;
    case 'charger': return <>
      <rect className="pa-b" x="20" y="30" width="80" height="58" rx="8" />
      <rect className="pa-a" x="30" y="40" width="40" height="28" rx="3" />
      <text className="pa-t" x="50" y="58" textAnchor="middle">6S</text>
      <circle className="pa-d" cx="84" cy="46" r="6" /><circle className="pa-d" cx="84" cy="66" r="4" />
      {[34, 48, 62].map(x => <rect key={x} className="pa-m" x={x} y="76" width="8" height="5" rx="1" />)}
    </>;
    default: return extra(id, name);
  }
}

function extra(id: string, name: string): ReactNode {
  if (/gopro|action/.test(id + name)) return <>
    <rect className="pa-a" x="22" y="32" width="76" height="56" rx="8" />
    <rect className="pa-d" x="30" y="40" width="34" height="40" rx="5" /><circle className="pa-b" cx="47" cy="60" r="12" /><circle className="pa-lens" cx="47" cy="60" r="6" />
    <rect className="pa-b" x="72" y="42" width="18" height="12" rx="2" />
  </>;
  if (/strap/.test(id)) return <>
    <path className="pa-strap" d="M 20 40 L 100 40 L 100 56 L 20 56 Z" /><path className="pa-strap" d="M 20 66 L 100 66 L 100 82 L 20 82 Z" />
    <rect className="pa-m" x="84" y="36" width="18" height="24" rx="3" /><rect className="pa-m" x="84" y="62" width="18" height="24" rx="3" />
  </>;
  if (/finder|buzzer/.test(id + name)) return <>
    <rect className="pa-a" x="36" y="40" width="48" height="36" rx="6" /><circle className="pa-d" cx="60" cy="58" r="10" /><circle className="pa-led" cx="76" cy="48" r="3" />
    <path className="pa-wire" d="M 18 46 q -6 12 0 24 M 102 46 q 6 12 0 24 M 26 50 q -3 8 0 16 M 94 50 q 3 8 0 16" />
  </>;
  if (/pinecil|iron/.test(id + name)) return <>
    <rect className="pa-a" x="20" y="54" width="56" height="14" rx="7" /><path className="pa-m" d="M 76 56 L 104 60 L 104 62 L 76 66 Z" />
    <path className="pa-wire" d="M 20 61 q -10 0 -10 20" />
  </>;
  if (/bag/.test(id)) return <>
    <path className="pa-a" d="M 26 44 L 94 44 L 100 96 L 20 96 Z" /><path className="pa-b" d="M 26 44 L 94 44 L 90 34 L 30 34 Z" />
    <path className="pa-d" d="M 54 58 L 66 58 L 62 72 L 70 72 L 54 90 L 58 76 L 50 76 Z" />
  </>;
  if (/xt60|pigtail/.test(id)) return <>
    <rect className="pa-plug" x="44" y="22" width="32" height="22" rx="3" />
    <path className="pa-wire is-thick" d="M 54 44 q 0 30 -12 56 M 66 44 q 0 30 12 56" />
  </>;
  if (/shortsaver|smoke/.test(id)) return <>
    <rect className="pa-a" x="34" y="44" width="52" height="32" rx="5" /><circle className="pa-led" cx="76" cy="54" r="3" />
    <rect className="pa-plug" x="14" y="52" width="20" height="16" rx="2" /><rect className="pa-plug" x="86" y="52" width="20" height="16" rx="2" />
  </>;
  return <>
    <path className="pa-b" d="M 60 22 L 96 40 L 96 80 L 60 98 L 24 80 L 24 40 Z" />
    <path className="pa-a" d="M 60 22 L 96 40 L 60 58 L 24 40 Z" />
    <path className="pa-wire" d="M 60 58 L 60 98" />
  </>;
}
