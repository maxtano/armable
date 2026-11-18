import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assistant, Browser, startApp } from '../server/testkit';

/**
 * End to end: the built interface in a real browser, a real MCP assistant over HTTP, and a demo drone in the tab.
 * Needs `npm run build` first and Playwright with Chromium installed. Skipped otherwise, unless E2E=1 demands it.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });
// Playwright is resolved at run time so the suite works where it is installed globally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PW = any;
let pw: PW | undefined;
try { pw = createRequire(import.meta.url)('playwright') as PW; } catch { pw = undefined; }
const ready = !!pw && existsSync('dist/index.html');
if (!ready && process.env.E2E) throw new Error('E2E=1 but Playwright or the build (dist/) is missing.');

describe.skipIf(!ready)('Armable in a browser', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let browser: any;
  beforeAll(async () => { app = await startApp(undefined, 'dist'); browser = await pw!.chromium.launch(); });
  afterAll(async () => { await browser?.close(); await app?.close(); });

  async function signedInPage(width = 1440, height = 900) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(app.base);
    await expect(page.getByRole('heading', { name: /Your drone/ })).toBeTruthy();
    // No sign-up: a guest bench opens at once.
    await page.click('button:has-text("just look around")');
    await page.waitForSelector('[data-demo=ardupilot]');
    return { page, context, errors };
  }

  it('explains itself before sign-in, in few words', async () => {
    const page = await browser.newPage();
    await page.goto(app.base);
    const text = await page.locator('.in-hero').innerText();
    expect(text).toContain('One bench.');
    expect(text.split(/\s+/).length).toBeLessThan(70);
    expect(await page.locator('.in-drone').count()).toBe(1);
    await page.close();
  });

  it('connects a demo drone, draws it from its configuration, and changes a setting by hand with readback', async () => {
    const { page, errors } = await signedInPage();
    await page.click('[data-demo=ardupilot]');
    await page.waitForSelector('.lu-status.is-connected');
    await page.waitForFunction(() => document.querySelectorAll('[data-motor]').length === 4 && !document.querySelector('.dg-unknown'));
    expect(await page.locator('.dg-caption').textContent()).toContain('Quad X');
    await page.click('[aria-label^="Battery"]');
    const capacity = page.locator('[data-setting="param.BATT_CAPACITY"]');
    await capacity.waitFor();
    await capacity.getByRole('button', { name: /Raise/ }).click();
    await capacity.getByRole('button', { name: /Apply/ }).click();
    await page.waitForSelector('.lu-toast.is-ok');
    expect(await page.locator('.lu-toast').innerText()).toMatch(/confirmed by reading back/);
    await page.waitForFunction(() => (document.querySelector('[data-setting="param.BATT_CAPACITY"] input') as HTMLInputElement | null)?.value === '1350');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('lets an assistant find, propose and wait, while the person approves on the motor itself', async () => {
    const { page, context, errors } = await signedInPage();
    await page.click('[data-demo=ardupilot]');
    await page.waitForSelector('.lu-status.is-connected');
    // Connect an assistant with this person's session, the way an assistant app would.
    const person = new Browser(app.base);
    person.cookie = (await context.cookies()).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
    const grant = await person.connectAssistant('Claude');
    const claude = await assistant(app.base, grant.access_token!);
    try {
      expect((await claude.call('get_workspace')).aircraft).toMatchObject({ connected: true, stack: 'ardupilot' });
      expect((await claude.call('find', { query: 'motor spins the wrong way' })).hits[0].id).toBe('play.motor-wrong-way');
      await claude.call('read', { ids: ['settings.load'] });

      // Reading the ESCs is itself a hardware action: the person confirms it on screen.
      const read = await claude.call('run_test', { id: 'esc.read', reason: 'To see each motor direction.' });
      await page.waitForSelector(`[data-proposal="${read.proposal}"]`);
      for (const label of ['Props removed', 'Direct USB', 'Battery connected']) await page.locator(`[data-proposal="${read.proposal}"] label:has-text("${label}")`).click();
      await page.locator(`[data-proposal="${read.proposal}"] button:has-text("Approve")`).click();
      expect((await claude.call('wait', { proposal: read.proposal })).status).toBe('done');

      const proposal = await claude.call('propose_change', { changes: [{ id: 'esc.3.direction', value: 'normal' }], reason: 'Motor 3 turns the wrong way.' });
      // Follow mode takes the person to motor 3, where the ghost arrow and the Approve button appear.
      await page.waitForSelector('[data-motor="3"].needs-you .dg-ghost');
      const card = page.locator(`[data-proposal="${proposal.proposal}"]`);
      await card.waitFor();
      expect(await card.innerText()).toMatch(/Claude[\s\S]*reversed[\s\S]*normal[\s\S]*Motor 3 turns the wrong way/i);
      const approveButton = card.getByRole('button', { name: 'Approve' });
      expect(await approveButton.isDisabled()).toBe(true);
      await card.locator('label:has-text("Props removed")').click();
      await card.locator('label:has-text("Direct USB")').click();
      const waiting = claude.call('wait', { proposal: proposal.proposal, seconds: 30 });
      await approveButton.click();
      expect(await waiting).toMatchObject({ status: 'done', result: { ok: true, changes: [{ before: 'reversed', after: 'normal', ok: true }] } });
      await page.waitForSelector('[data-motor="3"]:not(.needs-you)');
      expect((await claude.call('read', { ids: ['esc.3.direction'] })).values[0].value).toBe('normal');
      // The timeline shows both sides.
      expect(await page.locator('.lu-dot.is-assistant').count()).toBeGreaterThan(0);
      expect(await page.locator('.lu-dot.kind-change').count()).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally { await claude.close(); await page.close(); }
  });

  it('lets someone with no drone build one: parts appear live, and the person swaps and compares them', async () => {
    const { page, context, errors } = await signedInPage();
    await page.click('.lu-build-cta');
    await page.click('button:has-text("Start my build")');
    await page.waitForSelector('.bd-sheet');
    const person = new Browser(app.base);
    person.cookie = (await context.cookies()).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
    const grant = await person.connectAssistant('Claude');
    const claude = await assistant(app.base, grant.access_token!);
    try {
      const build = (await claude.call('get_workspace')).documents.find((d: { kind: string }) => d.kind === 'build');
      const edited = await claude.call('edit', { document: build.id, baseRevision: build.revision, operations: [{ op: 'from', build: 'proven.5in-analog-starter' }, { op: 'note', text: 'Starting from the analog starter: cheap spares while you learn.' }] });
      expect(edited.checks.complete).toBe(true);
      await page.waitForSelector('.bd-row:has-text("Source One")');
      expect(await page.locator('.bd-row:not(.is-empty)').count()).toBe(9);
      await page.click('[aria-label="Swap the Motors"]');
      await page.click('.bd-product:has-text("Velox") button:has-text("Swap in")');
      await page.waitForSelector('.bd-row:has-text("Velox")');
      const doc = (await claude.call('read', { ids: [build.id] })).values[0].value;
      expect(doc.parts.find((p: { slot: string }) => p.slot === 'motors')).toMatchObject({ part: 'motor.velox-v2207-1950', qty: 4 });
      // Rate a part from its page, and see the stars on the sheet.
      await page.click('.bd-row:has-text("Velox") .bd-name-link');
      await page.click('.bd-rate-stars button[aria-label="4 stars"]');
      await page.fill('.bd-rate textarea', 'Smooth and tough.');
      await page.click('button:has-text("Post rating")');
      await page.waitForSelector('.bd-review:has-text("Smooth and tough.")');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.bd-row:has-text("Velox") .bd-rating:has-text("4.0 (1)")');
      await page.click('[role=radio]:has-text("Browse parts")');
      await page.click('.bd-cats button:has-text("Battery")');
      expect(await page.locator('.bd-product').count()).toBe(6);
      await page.click('[role=radio]:has-text("Compare")');
      await page.waitForSelector('.bd-table');
      expect(errors).toEqual([]);
    } finally { await claude.close(); await context.close(); }
  });

  it('opens straight into the demo from a link, takes feedback, and shares a build anyone can open', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    // A link posted anywhere: no sign-up, the demo drone connects, and it will not arm.
    await page.goto(`${app.base}/?demo=betaflight`);
    await page.waitForSelector('.lu-status.is-connected');
    await page.waitForSelector('.dg-chip:has-text("Won\'t arm")');
    expect(new URL(page.url()).search).toBe('');
    await page.click('button[aria-label="Menu"]');
    await page.waitForSelector('.lu-menu button:has-text("Save your bench")');
    await page.click('.lu-menu button:has-text("Send feedback")');
    await page.fill('textarea[aria-label="Your feedback"]', 'The demo is great.');
    await page.click('.gr-dialog button:has-text("Send")');
    await page.waitForSelector('.gr-thanks');
    // Build, share, and open the link as someone else.
    await page.click('[data-section="build"]');
    await page.click('text=Start from this >> nth=0');
    await page.waitForSelector('.bd-row');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await page.click('.bd-sheet-head button:has-text("Share")');
    const link = await page.locator('.bd-share a').getAttribute('href');
    expect(link).toMatch(/\/b\/[\w-]+$/);
    const stranger = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const view = await stranger.newPage();
    await view.goto(link!);
    await view.waitForSelector('.bd-public .bd-row');
    expect(await view.title()).toMatch(/5" analog freestyle starter · a drone build on Armable/);
    expect(await view.locator('.bd-public .bd-row').count()).toBe(9);
    await view.click('button:has-text("Make a copy to change")');
    await view.waitForSelector('.bd-sheet .bd-row');
    expect(errors).toEqual([]);
    await stranger.close(); await context.close();
  });

  it('offers one-click setup for assistants, and a prompt that lets any agent set itself up', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(app.base);
    await page.getByRole('button', { name: /Use a coding tool/ }).click();
    const items = page.locator('.lu-connect-menu [role=menuitem]');
    expect((await items.allInnerTexts()).map((t: string) => t.split('\n')[0])).toEqual(['Claude Code', 'Cursor', 'VS Code', 'Any other agent']);
    await page.click('[data-connect=agents]');
    await page.waitForSelector('.lu-connect-steps:has-text("Paste it into your agent")');
    const prompt = await page.evaluate(() => navigator.clipboard.readText());
    expect(prompt).toBe(`Read and follow ${app.base}/agent-onboarding/SKILL.md`);
    const skill = await (await fetch(prompt.replace('Read and follow ', ''))).text();
    expect(skill).toContain(`${app.base}/mcp`);
    await page.getByRole('button', { name: 'Back' }).click();
    await page.click('[data-connect=claude-code]');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`claude mcp add --transport http armable ${app.base}/mcp`);
    await page.keyboard.press('Escape');
    expect(await page.locator('.lu-connect-menu').count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('takes a new person from “Which AI do you use?” to a new Claude chat with “Start Armable” typed, with one Allow', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await context.route('https://claude.ai/**', (route: any) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Claude</title>' }));
    await context.route('http://localhost:9/**', (route: any) => route.fulfill({ status: 200, contentType: 'text/html', body: 'back in Claude' }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(app.base);
    // 1. One choice. Claude opens in its own window with Armable filled in.
    const [claude] = await Promise.all([page.waitForEvent('popup'), page.click('[data-start=claude]')]);
    await claude.waitForURL(/claude\.ai\/customize\/connectors/);
    const install = new URL(claude.url());
    expect(Object.fromEntries(install.searchParams)).toEqual({ modal: 'add-custom-connector', connectorName: 'Armable', connectorUrl: `${app.base}/mcp` });
    await page.waitForSelector('.cs-steps li.is-now[data-step="1"]');
    await page.waitForSelector('.cs-wait:has-text("Waiting for you")');
    // 2. Claude's Connect opens Armable's sign-in. Not signed in: one screen, one Allow, no account needed.
    const redirect = 'http://localhost:9/callback';
    const client = await (await fetch(`${app.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json() as { client_id: string };
    const verifier = 'v'.repeat(64), challenge = createHash('sha256').update(verifier).digest('base64url');
    const allow = await context.newPage();
    await allow.goto(`${app.base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'observe design propose' })}`);
    await allow.waitForSelector('h1:has-text("Let Claude use Armable?")');
    await allow.click('[data-allow]');
    await allow.waitForURL(/localhost:9\/callback\?.*code=/);
    const code = new URL(allow.url()).searchParams.get('code')!;
    await fetch(`${app.base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect }) });
    // 3. Armable notices by itself, and opens the bench behind the checklist.
    await page.waitForSelector('.cs h2:has-text("Claude is connected")', { timeout: 10000 });
    await page.waitForSelector('.cs-light.is-on:has-text("Claude connected")');
    // 4. One last click: a new chat in a normal tab, with “Start Armable” typed. The setup window goes away.
    const [chat] = await Promise.all([context.waitForEvent('page'), page.click('[data-open-chat]')]);
    await chat.waitForURL(/claude\.ai\/new\?q=/);
    expect(new URL(chat.url()).searchParams.get('q')).toBe('Start Armable');
    await expect.poll(() => claude.isClosed()).toBe(true);
    expect(await page.locator('.cs').count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('sets up ChatGPT with the address copied and each click spelled out', async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await context.route('https://chatgpt.com/**', (route: any) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>ChatGPT</title>' }));
    const page = await context.newPage();
    await page.goto(app.base);
    const [chatgpt] = await Promise.all([page.waitForEvent('popup'), page.click('[data-start=chatgpt]')]);
    expect(chatgpt.url()).toMatch(/^https:\/\/chatgpt\.com\//);
    await page.waitForSelector('.cs h2:has-text("Connect ChatGPT")');
    await page.waitForSelector('.cs-steps:has-text("Developer mode")');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${app.base}/mcp`);
    await context.close();
  });

  it('keeps the way back to setup in the top bar until an AI is connected', async () => {
    const context = await browser.newContext();
    await context.route('https://claude.ai/**', (route: any) => route.fulfill({ status: 200, contentType: 'text/html', body: 'Claude' }));
    const page = await context.newPage();
    await page.goto(`${app.base}/?demo=betaflight`);
    await page.waitForSelector('.lu-status.is-connected');
    await page.click('.cs-light:has-text("Connect your AI")');
    await page.waitForSelector('.cs h2:has-text("Which AI do you use?")');
    const [claude] = await Promise.all([page.waitForEvent('popup'), page.click('.cs [data-start=claude]')]);
    await page.waitForSelector('.cs h2:has-text("Connect Claude")');
    await claude.close();
    await context.close();
  });

  it('works at phone width', async () => {
    const { page, errors } = await signedInPage(390, 844);
    await page.click('[data-demo=betaflight]');
    await page.waitForSelector('.lu-status.is-connected');
    await page.click('[data-motor="1"]');
    await page.waitForSelector('.lu-panel');
    const box = await page.locator('.lu-panel').boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('moves OSD elements on the screen picture and saves them to the flight controller', async () => {
    const { page, errors } = await signedInPage();
    await page.click('[data-demo=betaflight]');
    await page.waitForSelector('.lu-status.is-connected');
    await page.click('.lu-top button:has-text("Parts")');
    await page.click('.lu-menu button:has-text("On-screen display")');
    const vbat = page.locator('[data-osd="vbat"]');
    await vbat.waitFor();
    await vbat.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    expect(await vbat.getAttribute('aria-label')).toContain('column 4, row 13');
    await page.getByRole('button', { name: 'Hide RSSI' }).click();
    await page.getByRole('button', { name: /^Save 2$/ }).click();
    await page.waitForSelector('.lu-toast.is-ok', { timeout: 20000 });
    // The flight controller restarted to save; after reconnecting, the editor shows what it reads back.
    await page.waitForSelector('.lu-status.is-connected', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('[data-osd="vbat"]')?.getAttribute('aria-label')?.includes('column 4, row 13'), undefined, { timeout: 20000 });
    expect(await page.locator('[data-osd="rssi"]').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('gives the video transmitter a table, then shows bands and frequencies by name', async () => {
    const { page, errors } = await signedInPage();
    await page.click('[data-demo=betaflight]');
    await page.waitForSelector('.lu-status.is-connected');
    await page.click('.lu-top button:has-text("Parts")');
    await page.click('.lu-menu button:has-text("Video")');
    const table = page.locator('[data-setting="bf.vtxtable"]');
    await table.waitFor();
    await table.locator('select').selectOption('Tramp');
    await table.getByRole('button', { name: /Apply/ }).click();
    await page.waitForSelector('.lu-status.is-connected', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('[data-setting="bf.vtx_band"] select')?.textContent?.includes('raceband'), undefined, { timeout: 20000 });
    expect(await page.locator('.lu-readings').innerText()).toMatch(/5917 MHz[\s\S]*25 mW|5917 MHz/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('downloads and analyses a Betaflight blackbox log, and opens a log file from disk', async () => {
    const { page, errors } = await signedInPage();
    await page.click('[data-demo=betaflight]');
    await page.waitForSelector('.lu-status.is-connected');
    await page.click('[data-view="flights"]');
    await page.click('button:has-text("Analyse latest")');
    await page.waitForSelector('.lu-findings', { timeout: 30000 });
    expect(await page.locator('.lu-page-head').innerText()).toContain('Betaflight Blackbox');
    expect(await page.locator('.lu-chips button').count()).toBe(2);
    const { syntheticBlackbox } = await import('../src/device/blackbox/encode');
    await page.setInputFiles('[data-log-file]', { name: 'flight.bbl', mimeType: 'application/octet-stream', buffer: Buffer.from(syntheticBlackbox(3, 1)) });
    await page.waitForSelector('.lu-toast:has-text("flight.bbl analysed")');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('lets a standing permission carry an assistant change through with no click, and records it in History', async () => {
    const { page, context, errors } = await signedInPage();
    await page.click('[data-demo=betaflight]');
    await page.waitForSelector('.lu-status.is-connected');
    await page.click('button[aria-label="Menu"]');
    await page.click('.lu-menu button:has-text("Your assistant")');
    await page.getByRole('button', { name: 'Allow' }).click();
    await page.waitForSelector('.lu-toast:has-text("Permission on")');
    const person = new Browser(app.base);
    person.cookie = (await context.cookies()).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
    const claude = await assistant(app.base, (await person.connectAssistant('Claude')).access_token!);
    try {
      await claude.call('read', { ids: ['settings.load'] });
      const p = await claude.call('propose_change', { changes: [{ id: 'bf.p_roll', value: 48 }] });
      expect(p.status).toBe('approved');
      expect((await claude.call('wait', { proposal: p.proposal, seconds: 30 })).status).toBe('done');
      await page.click('[data-section="bench"]');
      await page.click('[data-view="history"]');
      await page.waitForSelector('.lu-hrow:has-text("propose_change")');
      await page.click('.lu-chips button:has-text("Changes")');
      await page.waitForSelector('.lu-hrow:has-text("bf.p_roll")');
      expect(await page.locator('.lu-hrow:has-text("bf.p_roll")').innerText()).toMatch(/Claude[\s\S]*45[\s\S]*48[\s\S]*confirmed/);
      expect(errors).toEqual([]);
    } finally { await claude.close(); await page.close(); }
  });

  it('keeps working offline once loaded, and syncs the history when back online', async () => {
    const { page, context, errors } = await signedInPage();
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null || navigator.serviceWorker?.ready, undefined, { timeout: 10000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForSelector('[data-demo=ardupilot]');
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('.lu-offline:has-text("Offline")');
    await page.click('[data-demo=ardupilot]');
    await page.waitForSelector('.lu-status.is-connected');
    await page.click('[aria-label^="Battery"]');
    const capacity = page.locator('[data-setting="param.BATT_CAPACITY"]');
    await capacity.waitFor();
    await capacity.getByRole('button', { name: /Raise/ }).click();
    await capacity.getByRole('button', { name: /Apply/ }).click();
    await page.waitForSelector('.lu-toast.is-ok');
    await context.setOffline(false);
    // Back online without a reload: the drone stays connected and the offline change reaches the history.
    await page.waitForSelector('.lu-toast:has-text("Back online")', { timeout: 10000 });
    expect(await page.locator('.lu-status.is-connected').count()).toBe(1);
    await page.click('[data-section="bench"]');
      await page.click('[data-view="history"]');
    await page.click('.lu-chips button:has-text("Changes")');
    await page.waitForSelector('.lu-hrow:has-text("param.BATT_CAPACITY")', { timeout: 10000 });
    expect(errors.filter(e => !/Failed to fetch|NetworkError|ERR_INTERNET/.test(e))).toEqual([]);
    await page.close();
  });
});
