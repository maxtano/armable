/**
 * Records a draft of the launch video from a running server (npm run build && npm run serve): the demo drone that
 * will not arm, an assistant finding why, one approval, and then building a drone. Captions stand in for what the
 * person types in Claude, which a real recording shows side by side.
 *
 * Usage: npx tsx scripts/demo-video.ts [base-url] [output.mp4]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assistant, Browser } from '../server/testkit';

const base = process.argv[2] ?? 'http://localhost:8787';
const output = resolve(process.argv[3] ?? 'lucidity-demo.mp4');
const { chromium } = createRequire(import.meta.url)('playwright');
const frames = mkdtempSync(join(tmpdir(), 'lucidity-video-'));
const size = { width: 1280, height: 800 };
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: size, recordVideo: { dir: frames, size }, bypassCSP: true });
// The one-time “did this help?” questions belong to real use, not to the video.
await context.addInitScript(() => { try { localStorage.setItem('lucidity.asked.v1', JSON.stringify(['fix', 'build'])); } catch { /* storage unavailable */ } });
const page = await context.newPage();
const pause = (ms: number) => page.waitForTimeout(ms);

/** A caption at the bottom of the frame: who is speaking and what they say. */
async function caption(who: string, text: string) {
  await page.evaluate(([who, text]: string[]) => {
    let box = document.getElementById('video-caption');
    if (!box) {
      box = document.createElement('div'); box.id = 'video-caption';
      box.style.cssText = 'position:fixed;left:50%;top:74px;transform:translateX(-50%);z-index:9999;max-width:760px;padding:14px 22px;border-radius:999px;background:var(--ds-primary);color:var(--ds-on-primary);font:600 19px var(--font-sans);box-shadow:0 10px 30px #0004;transition:opacity 200ms';
      document.body.appendChild(box);
    }
    box.style.opacity = text ? '1' : '0';
    box.innerHTML = text ? `<span style="opacity:.6;margin-right:10px">${who}</span>${text}` : '';
  }, [who, text]);
}
async function card(title: string, line: string, ms: number) {
  await page.evaluate(([title, line]: string[]) => {
    const el = document.createElement('div'); el.id = 'video-card';
    el.style.cssText = 'position:fixed;inset:0;z-index:10000;display:grid;place-content:center;justify-items:center;gap:14px;background:var(--ds-bg);color:var(--ds-text);font-family:var(--font-sans);text-align:center';
    el.innerHTML = `<img src="/favicon.svg" width="64" height="64"><div style="font:800 54px var(--font-sans);letter-spacing:-.035em">${title}</div><div style="font:500 22px var(--font-sans);color:var(--ds-text-muted)">${line}</div>`;
    document.body.appendChild(el);
  }, [title, line]);
  await pause(ms);
  await page.evaluate(() => document.getElementById('video-card')?.remove());
}

// 1. The problem, on the bench.
await page.goto(`${base}/?demo=betaflight`);
await page.waitForSelector('.lu-status.is-connected');
await page.waitForSelector('.dg-chip');
await card('My new quad won’t arm.', 'The most common question in FPV.', 2600);
await pause(800);
await caption('You, in Claude', 'My new quad won’t arm. Why?');
await pause(2600);

// 2. The assistant looks, through Lucidity's tools, and the screen follows it.
const person = new Browser(base);
person.cookie = (await context.cookies()).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
const claude = await assistant(base, (await person.connectAssistant('Claude')).access_token!);
await caption('Claude', 'Checking what blocks arming…');
await claude.call('get_workspace');
await claude.call('find', { query: 'wont arm' });
await claude.call('show', { target: 'safety' });
await pause(2200);
await claude.call('read', { ids: ['settings.load'] });
await claude.call('show', { target: 'receiver' });
await caption('Claude', 'No signal from the receiver. It speaks CRSF, but the flight controller expects SBUS.');
await pause(3600);
const proposal = await claude.call('propose_change', { changes: [{ id: 'bf.serialrx_provider', value: 'CRSF' }], reason: 'Your ExpressLRS receiver speaks CRSF, not SBUS.' });
await page.waitForSelector(`[data-proposal="${proposal.proposal}"]`);
await caption('Claude', 'I’ve proposed the fix. Approve it in Lucidity.');
await pause(2800);

// 3. One click, and it is fixed and read back.
await caption('You', 'Approve.');
await pause(900);
await page.locator(`[data-proposal="${proposal.proposal}"] button:has-text("Approve")`).click();
await claude.call('wait', { proposal: proposal.proposal, seconds: 30 });
await page.waitForSelector('.lu-status.is-connected');
await page.waitForFunction(() => !document.querySelector('.dg-chip'), undefined, { timeout: 20_000 }).catch(() => {});
await page.click('.lu-panel button[aria-label="Close"]').catch(() => {});
await caption('Claude', 'Done. The receiver is talking, and nothing blocks arming.');
await pause(3600);
await caption('', '');

// 4. No drone yet? Build one.
await card('No drone yet?', 'Build one. Every part checked to work together.', 2400);
await page.click('.lu-rail button:has-text("Build")');
await page.click('text=Start from this >> nth=1');
await page.waitForSelector('.bd-row');
await pause(2800);
await page.click('[aria-label="Swap the Motors"]');
await page.waitForSelector('.bd-panel');
await pause(2200);
await page.click('.bd-product:has-text("XING2") button:has-text("Swap in")');
await pause(2600);
await page.evaluate(() => document.querySelector('.lu-view')?.scrollTo({ top: 760, behavior: 'smooth' }));
await pause(2600);

// 5. The end card.
await card('Lucidity', 'Free and open source. Works in your browser.', 3200);

await claude.close();
const video = page.video();
await context.close();
await browser.close();
const webm = await video!.path();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', output]);
for (const file of readdirSync(frames)) renameSync(join(frames, file), join(frames, `done-${file}`));
console.log(`saved ${output}`);
