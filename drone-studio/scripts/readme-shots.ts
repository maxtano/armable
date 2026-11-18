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

await page.fill('input[type=email]', `readme${Date.now()}@example.test`);
await page.fill('input[type=password]', 'correct horse');
await page.click('button:has-text("Create account")');
await page.waitForSelector('[data-demo=ardupilot]');
await page.click('[data-demo=ardupilot]');
await page.waitForSelector('.lu-status.is-connected');

const person = new Browser(base);
person.cookie = (await context.cookies()).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
const claude = await assistant(base, (await person.connectAssistant('Claude')).access_token!);
await claude.call('read', { ids: ['settings.load'] });
const read = await claude.call('run_test', { id: 'esc.read' });
await page.waitForSelector(`[data-proposal="${read.proposal}"]`);
for (const label of ['Props removed', 'Direct USB', 'Battery connected']) await page.locator(`[data-proposal="${read.proposal}"] label:has-text("${label}")`).click();
await page.locator(`[data-proposal="${read.proposal}"] button:has-text("Approve")`).click();
await claude.call('wait', { proposal: read.proposal });
const proposal = await claude.call('propose_change', { changes: [{ id: 'esc.3.direction', value: 'normal' }], reason: 'Motor 3 turns the wrong way.' });
await page.waitForSelector('[data-motor="3"].needs-you .dg-ghost');
await page.waitForTimeout(1200);
await shot('proposal');
await claude.call('stop', { proposal: proposal.proposal });
await page.click('.lu-panel button[aria-label="Close"]').catch(() => {});

await page.click('.lu-rail button:has-text("Signals")');
await page.waitForTimeout(2500);
await shot('signals');

await page.click('.lu-rail button:has-text("Build")');
await page.click('text=Start from this >> nth=1');
await page.waitForSelector('.bd-row');
await page.waitForTimeout(6000); // Let the toast go.
await shot('build');
await page.click('[aria-label="Swap the Motors"]');
await page.waitForSelector('.bd-panel');
await page.waitForTimeout(500);
await shot('parts');

await claude.close();
await browser.close();
console.log(`saved to ${out}`);
