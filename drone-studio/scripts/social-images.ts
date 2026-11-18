/**
 * Renders the images shown when a Lucidity link is shared: the site's preview images and GitHub's social preview.
 * Usage: npx tsx scripts/social-images.ts
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = new URL('../../', import.meta.url).pathname;
const font = readFileSync(`${root}drone-studio/public/fonts/manrope-normal-latin.woff2`).toString('base64');
const logo = readFileSync(`${root}drone-studio/public/favicon.svg`).toString('base64');
const shot = readFileSync(`${root}site/media/proposal.jpg`).toString('base64');

const card = (title: string, sub: string, picture: boolean) => `<!doctype html><html><head><style>
  @font-face { font-family: M; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 200 800; }
  * { margin: 0; box-sizing: border-box; }
  body { width: 100vw; height: 100vh; overflow: hidden; background: #e9e7e2; font-family: M; color: #1c1c1a; display: grid; grid-template-columns: ${picture ? '1fr 1.05fr' : '1fr'}; align-items: center; gap: 40px; padding: 64px; }
  .brand { display: flex; align-items: center; gap: 14px; font-weight: 800; font-size: 30px; letter-spacing: -0.02em; }
  .brand img { width: 48px; height: 48px; border-radius: 11px; }
  h1 { margin-top: 34px; font-weight: 800; font-size: ${picture ? 66 : 82}px; line-height: 1.02; letter-spacing: -0.045em; }
  h1 em { font-style: normal; color: #e2561c; }
  p { margin-top: 22px; font-weight: 600; font-size: 28px; line-height: 1.35; color: #45443f; max-width: 22ch; }
  .coil { margin-top: 30px; height: 10px; width: 160px; border-radius: 5px; background: repeating-linear-gradient(105deg, #b8692f 0 7px, #7c4219 7px 10px, transparent 10px 15px), #57554f; }
  .pic { height: 100%; display: grid; align-items: center; }
  .pic img { width: 100%; border-radius: 20px; border: 1px solid #cdcac2; box-shadow: 0 24px 60px #3a2f2230; }
</style></head><body>
  <div><div class="brand"><img src="data:image/svg+xml;base64,${logo}">Lucidity</div><h1>${title}</h1><p>${sub}</p><div class="coil"></div></div>
  ${picture ? `<div class="pic"><img src="data:image/jpeg;base64,${shot}"></div>` : ''}
</body></html>`;

const browser = await chromium.launch();
const render = async (html: string, path: string, width: number, height: number) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path });
  await page.close();
};
await render(card('Drone tools for <em>your AI.</em>', 'Ask Claude or ChatGPT what’s wrong. Approve the fix. Free and open source.', true), `${root}site/media/og.png`, 1200, 630);
await render(card('Quad won’t arm? <em>Here’s why.</em>', 'Every Betaflight arming flag in plain words, with the fix for each.', true), `${root}site/media/og-wont-arm.png`, 1200, 630);
await render(card('Drone tools for <em>your AI.</em>', 'Plug in your FPV drone. Ask Claude or ChatGPT. Approve the fix.', true), `${root}docs/media/social-preview.png`, 1280, 640);
await browser.close();
console.log('saved site/media/og.png, site/media/og-wont-arm.png, docs/media/social-preview.png');
