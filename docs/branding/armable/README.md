# Armable brand assets

The mark is a quadcopter from above with **no propellers** — the aircraft as it sits on the
bench, props off, while you read and change it. It is rotated **22°** so it reads as an
airframe in a turn rather than four dots in a box, and each motor carries a **lit core**.

Do not rotate it to 45°: four motors at north/east/south/west is a plus-quad, and any pilot
reads that as the wrong airframe.

## Files

| File | Use |
| --- | --- |
| `mark.svg` | The mark. Rings take `currentColor`; cores take `--armable-accent` |
| `mark-mono.svg` | One-colour mark for engraving, stencils and single-ink printing |
| `mark-dark-bg.svg`, `mark-light-bg.svg` | Fixed colours for places that cannot inherit, such as GitHub Markdown |
| `icon.svg` | App icon and favicon on a graphite tile. The source of `drone-studio/public/favicon.svg` and `site/favicon.svg` |
| `icon-light.svg` | App icon on porcelain, for light-only surfaces |
| `lockup.svg`, `lockup-dark-bg.svg`, `lockup-light-bg.svg` | Mark plus the lowercase `armable` wordmark |
| `loading.svg` | Standalone animated loading mark for static pages and docs |

In the app, use the React components instead of these files:
`ArmableMark` and `ArmableSpinner` from
[`drone-studio/src/platform/Visuals.tsx`](../../../drone-studio/src/platform/Visuals.tsx).

## Colour

Magenta is the system's one signal colour, the way orange was before it. The mark's cores,
the primary action, the accent and the focus ring are all the same family; the neutrals are
cool porcelain and graphite so the magenta is the only thing in the interface that glows.

| Token | Light | Dark |
| --- | --- | --- |
| `--ds-brand` (cores) | `#d10063` | `#ff2e88` |
| `--ds-brand-glow` | `#d1006359` | `#ff2e8899` |
| `--ds-accent` | `#a8004f` | `#ff5fa5` |
| Rings | `--ds-text` | `--ds-text` |

Status colours stay semantic and separate: green success, amber warning, red danger, teal
info. Every palette value lives in
[`tokens.css`](../../../drone-studio/src/design-system/tokens.css); the public pages keep a
matching copy in [`site/style.css`](../../../site/style.css), and the hero's dusk and ASCII
airframe are coloured inline in [`site/index.html`](../../../site/index.html).

The standalone SVGs read `--armable-accent`, which `tokens.css` aliases to `--ds-brand`.

## Loading

The cores light in motor order — front left, front right, rear right, rear left — on a
1.4 s cycle, each with a short glow. It reports that the interface is busy. It is never
aircraft state and never implies an armed or flying aircraft. Under
`prefers-reduced-motion: reduce` the animation stops and the cores sit at rest.

## Wordmark

Lowercase `armable`, Manrope 600, letter-spacing `-0.02em`. The lockup SVGs set
`font-family: Manrope` with a sans-serif fallback; they are not outlined, so a viewer
without Manrope installed sees its substitute. Prefer the React components in the app,
where Manrope is bundled.

## Clear space and minimum size

Keep clear space of one motor radius (4 units at the 32-unit grid) on every side. The mark
holds down to 16px; below that, use `icon.svg` on its tile. Do not recolour the rings,
add propellers, outline the cores, or set the mark on a busy photograph.
