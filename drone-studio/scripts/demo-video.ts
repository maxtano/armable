/**
 * Records a draft of the launch video from a running server (npm run build && npm run serve).
 * One story, told by motion: a chat with the assistant on the left, Lucidity on the right. A new quad won't arm;
 * the assistant finds why on the drone; one approval; it arms.
 *
 * The chat panel is drawn by this script. The tool calls behind it are real, made through Lucidity's MCP endpoint.
 * Usage: npx tsx scripts/demo-video.ts [base-url] [output.mp4]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assistant, Browser } from '../server/testkit';

const base = process.argv[2] ?? 'http://localhost:8787';
const output = resolve(process.argv[3] ?? 'lucidity-demo.mp4');
const { chromium } = createRequire(import.meta.url)('playwright');
const size = { width: 1920, height: 1080 }, CHAT = 620;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: size, recordVideo: { dir: mkdtempSync(resolve(tmpdir(), 'lucidity-video-')), size }, bypassCSP: true });
await context.addInitScript(() => { try { localStorage.setItem('lucidity.asked.v1', JSON.stringify(['fix', 'build'])); } catch { /* storage unavailable */ } });
const page = await context.newPage();
const pause = (ms: number) => page.waitForTimeout(ms);

/** The stage: the chat on the left, Lucidity on the right, a cursor, and a title layer. */
async function stage() {
  await page.evaluate((chat: number) => {
    const css = document.createElement('style');
    css.textContent = `
      #root { position: fixed; top: 0; bottom: 0; right: 0; left: ${chat}px; }
      .lu { height: 100vh; } .lu-main { height: 100vh; }
      .lu-timeline, .lu-toast { display: none !important; }
      #v-chat { position: fixed; left: 0; top: 0; bottom: 0; width: ${chat}px; z-index: 50; display: grid; grid-template-rows: auto 1fr auto; background: var(--lu-face); border-right: 1px solid var(--ds-border); font-family: var(--font-sans); }
      #v-chat header { display: flex; align-items: center; gap: 12px; padding: 26px 32px; font: 800 24px var(--font-sans); letter-spacing: -.02em; color: var(--ds-text); }
      #v-chat header i { width: 34px; height: 34px; border-radius: 10px; background: var(--ds-feature); }
      #v-log { display: flex; flex-direction: column; justify-content: flex-end; gap: 18px; padding: 0 32px 24px; overflow: hidden; }
      .v-you { align-self: flex-end; max-width: 82%; padding: 16px 22px; border-radius: 22px 22px 6px 22px; background: var(--ds-primary); color: var(--ds-on-primary); font: 600 25px/1.35 var(--font-sans); animation: v-in .35s cubic-bezier(.2,1.3,.4,1); }
      .v-ai { max-width: 92%; color: var(--ds-text); font: 500 25px/1.42 var(--font-sans); animation: v-in .35s ease-out; }
      .v-ai b { color: var(--lu-signal); font-weight: 800; }
      .v-tool { align-self: flex-start; display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-radius: 999px; background: var(--ds-surface-raised); color: var(--ds-text-muted); font: 700 17px var(--font-sans); animation: v-in .3s ease-out; }
      .v-tool::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: var(--lu-copper); }
      .v-tool.is-done::before { background: var(--lu-lamp); }
      .v-dots span { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 50%; background: var(--ds-text-subtle); animation: v-dot 1s infinite; }
      .v-dots span:nth-child(2) { animation-delay: .15s } .v-dots span:nth-child(3) { animation-delay: .3s }
      #v-input { margin: 0 24px 26px; padding: 20px 24px; min-height: 70px; border: 1.5px solid var(--ds-border-strong); border-radius: 20px; background: var(--ds-surface); color: var(--ds-text); font: 500 24px var(--font-sans); }
      #v-input:empty::before { content: 'Message Claude'; color: var(--ds-text-subtle); }
      #v-input.is-typing::after { content: ''; display: inline-block; width: 2px; height: 26px; margin-left: 2px; vertical-align: -4px; background: var(--ds-text); animation: v-blink .8s steps(1) infinite; }
      #v-cursor { position: fixed; left: 1300px; top: 700px; z-index: 60; width: 34px; height: 34px; pointer-events: none; transition: left .9s cubic-bezier(.5,0,.2,1), top .9s cubic-bezier(.5,0,.2,1); filter: drop-shadow(0 3px 6px #0005); }
      #v-cursor.is-click::after { content: ''; position: absolute; left: -16px; top: -16px; width: 36px; height: 36px; border-radius: 50%; border: 3px solid var(--lu-signal); animation: v-ring .5s ease-out forwards; }
      #v-title { position: fixed; inset: 0; z-index: 70; display: grid; place-content: center; justify-items: center; gap: 22px; background: var(--ds-bg); color: var(--ds-text); text-align: center; transition: opacity .5s; }
      #v-title b { font: 800 92px/1.02 var(--font-sans); letter-spacing: -.045em; max-width: 1400px; }
      #v-title small { font: 600 34px var(--font-sans); color: var(--ds-text-muted); }
      #v-title b em { font-style: normal; color: var(--lu-signal); }
      .v-spot { outline: 4px solid var(--lu-signal) !important; outline-offset: 8px; border-radius: 18px; transition: outline-offset .4s; }
      @keyframes v-in { from { opacity: 0; transform: translateY(14px) scale(.98); } }
      @keyframes v-dot { 50% { opacity: .25; transform: translateY(-3px); } }
      @keyframes v-blink { 50% { opacity: 0; } }
      @keyframes v-ring { to { transform: scale(2.2); opacity: 0; } }`;
    document.head.appendChild(css);
    const chatEl = document.createElement('aside'); chatEl.id = 'v-chat';
    chatEl.innerHTML = '<header><i></i>Claude</header><div id="v-log"></div><div id="v-input"></div>';
    document.body.appendChild(chatEl);
    const cursor = document.createElement('div'); cursor.id = 'v-cursor';
    cursor.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M4 2l16 10-7 1.5L9.5 21z" fill="#fff" stroke="#1c1c1a" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cursor);
  }, CHAT);
}
const title = (main: string, sub = '') => page.evaluate(([main, sub]) => {
  document.getElementById('v-title')?.remove();
  const el = document.createElement('div'); el.id = 'v-title';
  el.innerHTML = `<b>${main}</b>${sub ? `<small>${sub}</small>` : ''}`;
  document.body.appendChild(el);
}, [main, sub]);
const untitle = async () => { await page.evaluate(() => { const el = document.getElementById('v-title'); if (el) el.style.opacity = '0'; }); await pause(500); await page.evaluate(() => document.getElementById('v-title')?.remove()); };
async function type(text: string) {
  await page.evaluate(() => document.getElementById('v-input')!.classList.add('is-typing'));
  for (const ch of text) { await page.evaluate(c => { document.getElementById('v-input')!.textContent += c; }, ch); await pause(ch === ' ' ? 45 : 32); }
  await pause(450);
  await page.evaluate(() => { const input = document.getElementById('v-input')!; const msg = document.createElement('div'); msg.className = 'v-you'; msg.textContent = input.textContent; document.getElementById('v-log')!.appendChild(msg); input.textContent = ''; input.classList.remove('is-typing'); });
}
const say = (html: string, kind = 'v-ai') => page.evaluate(([html, kind]) => { document.querySelector('.v-dots')?.remove(); const el = document.createElement('div'); el.className = kind; el.innerHTML = html; document.getElementById('v-log')!.appendChild(el); }, [html, kind]);
const thinking = () => say('<span></span><span></span><span></span>', 'v-ai v-dots');
const doneTools = () => page.evaluate(() => document.querySelectorAll('.v-tool').forEach(t => t.classList.add('is-done')));
async function pointAt(selector: string, click = false) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) return;
  await page.evaluate(([x, y]) => { const c = document.getElementById('v-cursor')!; c.style.left = `${x}px`; c.style.top = `${y}px`; }, [box.x + box.width / 2, box.y + box.height / 2]);
  await pause(1000);
  if (click) { await page.evaluate(() => { const c = document.getElementById('v-cursor')!; c.classList.remove('is-click'); void c.offsetWidth; c.classList.add('is-click'); }); await page.locator(selector).first().click(); }
}
const spot = (selector: string | null) => page.evaluate(sel => { document.querySelectorAll('.v-spot').forEach(e => e.classList.remove('v-spot')); if (sel) document.querySelector(sel)?.classList.add('v-spot'); }, selector);

// Open on the demo drone, behind the first title.
await page.goto(`${base}/?demo=betaflight`);
await page.waitForSelector('.lu-status.is-connected');
await stage();
await title('My new quad <em>won’t arm.</em>', 'The most asked question in FPV.');
await page.waitForSelector('.dg-chip');
await pause(2600);
await untitle();
await pause(600);

// Ask.
await type('My new quad won’t arm. Why?');
await pause(500);
await thinking();

// The assistant looks, for real, through Lucidity.
const person = new Browser(base);
person.cookie = (await context.cookies()).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
const claude = await assistant(base, (await person.connectAssistant('Claude')).access_token!);
await pause(900);
await say('Lucidity · reading the drone', 'v-tool');
await claude.call('get_workspace');
await claude.call('show', { target: 'safety' });
await pause(1400);
await say('Lucidity · checking the receiver', 'v-tool');
await claude.call('read', { ids: ['settings.load'] });
await claude.call('show', { target: 'receiver' });
await pause(900);
await spot('[aria-label^="Radio"]');
await doneTools();
await pause(600);
await say('It hears <b>nothing from the receiver.</b> Your receiver speaks CRSF, but the drone expects SBUS.');
await pause(2600);
const proposal = await claude.call('propose_change', { changes: [{ id: 'bf.serialrx_provider', value: 'CRSF' }], reason: 'Your ExpressLRS receiver speaks CRSF, not SBUS.' });
await page.waitForSelector(`[data-proposal="${proposal.proposal}"]`);
await spot(`[data-proposal="${proposal.proposal}"]`);
await say('I’ve set up the fix. <b>Approve it</b> and I’ll check it worked.');
await pause(2200);

// One click.
await spot(null);
await pointAt(`[data-proposal="${proposal.proposal}"] button:has-text("Approve")`, true);
const waiting = claude.call('wait', { proposal: proposal.proposal, seconds: 30 });
await thinking();
await waiting;
await page.waitForSelector('.lu-status.is-connected');
await page.waitForFunction(() => !document.querySelector('.dg-chip'), undefined, { timeout: 20_000 }).catch(() => {});
await page.evaluate(() => { const c = document.getElementById('v-cursor')!; c.style.left = '1500px'; c.style.top = '1000px'; });
await say('Lucidity · confirmed on the drone', 'v-tool is-done');
await pause(700);
await spot('[aria-label^="Radio"]');
await say('Done. The receiver is talking and <b>nothing blocks arming.</b>');
await pause(3400);
await spot(null);

// The end.
await title('Lucidity', 'Your drone. Your AI. One bench. &nbsp;Free and open source.');
await pause(3600);

await claude.close();
const video = page.video();
await context.close();
await browser.close();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', await video!.path(), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', output]);
console.log(`saved ${output}`);
