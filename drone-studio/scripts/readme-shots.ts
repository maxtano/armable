/**
 * Captures the README images from a running server (npm run build && npm run serve).
 * Usage: npx tsx scripts/readme-shots.ts [base-url]
 */
import { createRequire } from 'node:module';
import { assistant, Browser } from '../server/testkit';

const base = process.argv[2] ?? 'http://localhost:8787';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = new URL('../../docs/media/', import.meta.url).pathname;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const shot = (name: string) => page.screenshot({ path: `${out}${name}.png` });

await page.goto(base);
await page.waitForTimeout(9000); // The intro animation rests on its last frame, the fixed motor.
await shot('intro');

await context.addInitScript(() => { try { localStorage.setItem('lucidity.asked.v1', JSON.stringify(['fix', 'build'])); } catch { /* storage unavailable */ } });
await page.goto(`${base}/?demo=betaflight`);
await page.waitForSelector('.lu-status.is-connected');
await page.waitForSelector('.dg-chip');

// The demo drone will not arm. An assistant finds why and proposes the fix on the receiver.
const person = new Browser(base);
person.cookie = (await context.cookies()).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
const claude = await assistant(base, (await person.connectAssistant('Claude')).access_token!);
await claude.call('read', { ids: ['settings.load'] });
const proposal = await claude.call('propose_change', { changes: [{ id: 'bf.serialrx_provider', value: 'CRSF' }], reason: 'Your ExpressLRS receiver speaks CRSF, not SBUS.' });
await page.waitForSelector(`[data-proposal="${proposal.proposal}"]`);
await page.waitForTimeout(6000); // Let the notice fade.
await shot('proposal');
await page.locator(`[data-proposal="${proposal.proposal}"] button:has-text("Approve")`).click();
await claude.call('wait', { proposal: proposal.proposal, seconds: 30 });
await page.waitForFunction(() => !document.querySelector('.dg-chip'), undefined, { timeout: 20_000 }).catch(() => {});
await page.click('.lu-panel button[aria-label="Close"]').catch(() => {});
await page.waitForTimeout(6000); // Let the confirmation notice fade.

await page.click('[data-view="signals"]');
await page.waitForTimeout(2500);
await shot('signals');

await page.click('[data-section="build"]');
await page.click('text=Start from this >> nth=1');
await page.waitForSelector('.bd-row');
await page.fill('input[aria-label="Budget in dollars"]', '750');
await page.locator('input[aria-label="Budget in dollars"]').blur();
await page.waitForTimeout(6000); // Let the toast go.
await shot('build');
await page.click('[aria-label="Swap the Motors"]');
await page.waitForSelector('.bd-panel');
await page.waitForTimeout(500);
await shot('parts');

await claude.close();
await browser.close();
console.log(`saved to ${out}`);
