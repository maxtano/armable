/**
 * The quad, raymarched into characters: signed distance fields, one ray per character cell.
 * No model file, no image, nothing to load - which is what makes it affordable in a panel the
 * host inlines as a single page. A bounding sphere turns the empty sky, almost the whole grid,
 * into one quadratic; the march only runs where the craft might actually be.
 *
 * The same renderer draws the hero on armable.ai. This is it fitted to a box rather than to a
 * headline, so the sizing is the only part that differs.
 */

function sdBox(px: number, py: number, pz: number, bx: number, by: number, bz: number, r: number) {
  const qx = Math.abs(px) - bx, qy = Math.abs(py) - by, qz = Math.abs(pz) - bz;
  const mx = qx > 0 ? qx : 0, my = qy > 0 ? qy : 0, mz = qz > 0 ? qz : 0;
  let o = qx > qy ? qx : qy; if (qz > o) o = qz;
  return Math.sqrt(mx * mx + my * my + mz * mz) + (o < 0 ? o : 0) - r;
}
function sdCyl(px: number, py: number, pz: number, r: number, h: number) {
  const d = Math.sqrt(px * px + pz * pz) - r, dy = Math.abs(py) - h;
  const a = d > dy ? d : dy, mx = d > 0 ? d : 0, my = dy > 0 ? dy : 0;
  return (a < 0 ? a : 0) + Math.sqrt(mx * mx + my * my);
}
function sdRing(px: number, py: number, pz: number, R: number, tr: number, h: number) {
  const q = Math.abs(Math.sqrt(px * px + pz * pz) - R) - tr, dy = Math.abs(py) - h;
  const a = q > dy ? q : dy, mx = q > 0 ? q : 0, my = dy > 0 ? dy : 0;
  return (a < 0 ? a : 0) + Math.sqrt(mx * mx + my * my);
}
function sdCap(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number) {
  const pax = px - ax, pay = py - ay, paz = pz - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  let h = (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz);
  h = h < 0 ? 0 : h > 1 ? 1 : h;
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/**
 * Five parts, three materials. map() is the hot one and runs tens of thousands of times a
 * frame; matAt() re-reads the same parts only where a ray actually landed, so the march never
 * has to carry a material around with it. Change one, change both.
 *
 * The props are rings rather than blades. The hero on armable.ai has columns to spare and can
 * afford three turning blades per rotor; here each one is thinner than a character cell, so
 * they dissolve into scattered marks. A solid disc is no better - one normal across the whole
 * face means every cell picks the same glyph - but a ring is a shape however flatly it shades,
 * it is what a turning prop actually looks like, and it is one primitive instead of three.
 */
function map(px: number, py: number, pz: number) {
  let d = sdBox(px, py, pz, .30, .095, .21, .055);                                  /* hull */
  let t = sdBox(px - .31, py - .045, pz, .045, .045, .062, .030); if (t < d) d = t; /* camera */
  const ax = px < 0 ? -px : px, az = pz < 0 ? -pz : pz;        /* four arms, one evaluation */
  t = sdCap(ax, py, az, .14, 0, .09, .60, 0, .48, .082);          if (t < d) d = t;
  t = sdCyl(ax - .60, py - .035, az - .48, .115, .095);           if (t < d) d = t; /* motors */
  t = sdRing(ax - .60, py - .150, az - .48, .238, .038, .016);    if (t < d) d = t; /* props */
  return d;
}
const M_BODY = 0, M_MOTOR = 1, M_BLADE = 2;
function matAt(px: number, py: number, pz: number) {
  let m = M_BODY, d = sdBox(px, py, pz, .30, .095, .21, .055);
  let t = sdBox(px - .31, py - .045, pz, .045, .045, .062, .030); if (t < d) { d = t; m = M_MOTOR; }
  const ax = px < 0 ? -px : px, az = pz < 0 ? -pz : pz;
  t = sdCap(ax, py, az, .14, 0, .09, .60, 0, .48, .082);          if (t < d) { d = t; m = M_BODY; }
  t = sdCyl(ax - .60, py - .035, az - .48, .115, .095);           if (t < d) { d = t; m = M_MOTOR; }
  t = sdRing(ax - .60, py - .150, az - .48, .238, .038, .016);    if (t < d) { d = t; m = M_BLADE; }
  return m;
}

/* Brightness picks the tier. Inside the dim tier the character is chosen by which way the
   surface runs on screen - strokes along the contour, square to the projected normal - and
   that, not the brightness ramp, is what reads as shape rather than as a gradient. */
const HATCH = ['-', '/', '|', '\\'];

export interface FlyingQuad { stop(): void; }

/**
 * Fly the craft inside `pre`, sizing the character grid to whatever box it is given.
 * Returns a handle; call stop() to release the frame loop and the observers.
 */
export function flyQuad(pre: HTMLPreElement): FlyingQuad {
  let QC = 0, QR = 0, asp = 1, t = 0, last = 0, frame = 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function size() {
    pre.style.paddingTop = '0px';
    const b = pre.getBoundingClientRect();
    if (!b.width || !b.height) { QC = 0; return; }
    /* The panel is narrow - 320px at its tightest - so the grid stays coarse and the glyphs
       stay large. Extra columns here read as noise, not as detail. */
    QC = b.width >= 420 ? 58 : b.width >= 330 ? 50 : 42;
    QR = b.width >= 420 ? 20 : b.width >= 330 ? 18 : 16;
    let fs = Math.min(b.width / (QC * .601), b.height / QR);
    fs = Math.max(3, Math.min(fs, 18));
    pre.style.fontSize = fs + 'px';
    pre.style.lineHeight = fs + 'px';
    const m = document.createElement('canvas').getContext('2d');
    let cw = fs * .6;
    if (m) { m.font = fs + 'px ' + getComputedStyle(pre).fontFamily; cw = m.measureText('M').width || cw; }
    asp = (QC * cw) / (QR * fs);
    /* Centred by hand: a flex or grid parent would turn every colour span into an item of
       its own and lay the whole character grid out in a single row. */
    pre.style.paddingTop = Math.max(0, (b.height - QR * fs) / 2) + 'px';
  }

  function draw() {
    if (!QC) return;
    const ang = t * .0135, bob = Math.sin(t * .034) * .085, bank = Math.sin(t * .022) * .20;

    const AIM = .13, SPHERE_Y = .05;
    const dist = 2.02, ey = 1.82 + Math.sin(t * .017) * .20;
    const rox = Math.sin(ang) * dist, roz = Math.cos(ang) * dist;
    let roy = ey;
    let fx = -rox, fy = AIM - roy, fz = -roz;
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz); fx /= fl; fy /= fl; fz /= fl;
    let rx = fz, ry = 0, rz = -fx;
    const rl = Math.sqrt(rx * rx + rz * rz); rx /= rl; rz /= rl;
    let ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    /* Bank rolls the whole basis about the view axis, so the march never pays for it. */
    const cb = Math.cos(bank), sb = Math.sin(bank);
    const r2x = rx * cb + ux * sb, r2y = ry * cb + uy * sb, r2z = rz * cb + uz * sb;
    ux = ux * cb - rx * sb; uy = uy * cb - ry * sb; uz = uz * cb - rz * sb;
    rx = r2x; ry = r2y; rz = r2z;
    roy -= bob;
    /* The key light rides with the camera, so the craft never orbits into its own shadow. */
    let Lx = -.46 * rx + .76 * ux - .45 * fx, Ly = -.46 * ry + .76 * uy - .45 * fy, Lz = -.46 * rz + .76 * uz - .45 * fz;
    const Ll = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz); Lx /= Ll; Ly /= Ll; Lz /= Ll;

    const FOV = .292, BR = 1.12, ocy = roy - SPHERE_Y;
    const cc = rox * rox + ocy * ocy + roz * roz - BR * BR;
    let out = '', open = -1;

    for (let row = 0; row < QR; row++) {
      const v = 1 - (row + .5) / QR * 2;
      for (let col = 0; col < QC; col++) {
        const u = ((col + .5) / QC * 2 - 1) * asp;
        let dx = fx + rx * u * FOV + ux * v * FOV, dy = fy + ry * u * FOV + uy * v * FOV, dz = fz + rz * u * FOV + uz * v * FOV;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz); dx /= dl; dy /= dl; dz /= dl;

        /* The sky is most of the grid - one quadratic keeps it nearly free. */
        const b = rox * dx + ocy * dy + roz * dz, disc = b * b - cc;
        let ch = ' ', cls = -1;
        if (disc > 0) {
          const sq = Math.sqrt(disc), t0 = -b - sq, t1 = -b + sq;
          if (t1 > 0) {
            let tt = t0 > 0 ? t0 : 0, hit = 0;
            for (let i = 0; i < 52; i++) {
              const d = map(rox + dx * tt, roy + dy * tt, roz + dz * tt);
              if (d < .005) { hit = 1; break; }
              tt += d; if (tt > t1) break;
            }
            if (hit) {
              const hx = rox + dx * tt, hy = roy + dy * tt, hz = roz + dz * tt, e = .004;
              const d0 = map(hx, hy, hz);
              let nx = map(hx + e, hy, hz) - d0, ny = map(hx, hy + e, hz) - d0, nz = map(hx, hy, hz + e) - d0;
              const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= nl; ny /= nl; nz /= nl;

              let lam = nx * Lx + ny * Ly + nz * Lz; if (lam < 0) lam = 0;
              let rim = 1 + (nx * dx + ny * dy + nz * dz); if (rim < 0) rim = 0;
              let lum = .20 + lam * .95 + rim * rim * .42;
              const mat = matAt(hx, hy, hz);
              /* The props catch the light as they turn. Lifting them out of the hatch tier is
                 what makes four bright rings instead of four patches of identical dashes. */
              if (mat === M_BLADE) lum += .15;
              if (lum > 1) lum = 1;
              const sh = lum < .38 ? 0 : lum < .66 ? 1 : 2;
              if (lum < .44) {
                const k = Math.round(Math.atan2(nx * ux + ny * uy + nz * uz, nx * rx + ny * ry + nz * rz) / .7853981634) + 2;
                ch = HATCH[((k % 4) + 4) % 4];
              }
              else if (lum < .64) ch = '+';
              else if (lum < .82) ch = '#';
              else ch = '@';
              cls = mat * 3 + sh;
            }
          }
        }
        if (cls < 0) { if (open >= 0) { out += '</i>'; open = -1; } out += ch; }
        else {
          if (cls !== open) { if (open >= 0) out += '</i>'; out += '<i class=q' + cls + '>'; open = cls; }
          out += ch;
        }
      }
      if (open >= 0) { out += '</i>'; open = -1; }
      out += '\n';
    }
    pre.innerHTML = out;
  }

  size();
  draw();

  const ro = new ResizeObserver(() => { size(); draw(); });
  ro.observe(pre);

  if (!reduce) {
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      /* Characters need nothing like 60fps, and every frame rewrites a few thousand of them.
         A hidden panel gets nothing at all. */
      if (document.visibilityState === 'hidden' || now - last < 45) return;
      last = now; t += 1.7; draw();
    };
    frame = requestAnimationFrame(tick);
  }

  return { stop() { cancelAnimationFrame(frame); ro.disconnect(); } };
}
