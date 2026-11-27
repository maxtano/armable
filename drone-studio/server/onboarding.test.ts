import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSkill } from './onboarding';
import { startApp } from './testkit';

describe('agent onboarding', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => { await app.close(); });

  it('serves a skill an agent can follow, written for this Armable', async () => {
    const response = await fetch(`${app.base}/agent-onboarding/SKILL.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/markdown/);
    const text = await response.text();
    expect(text).toMatch(/^---\nname: armable\ndescription: /);
    expect(text).toContain(`claude mcp add --transport http armable ${app.base}/mcp`);
    expect(text).toContain('get_workspace');
    expect(text).toContain('Never say a change is done until `wait` returns it done');
    // A chat assistant can't add connectors: it hands the person Claude's one-click link instead of trying.
    expect(text).toContain(`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Armable&connectorUrl=${encodeURIComponent(`${app.base}/mcp`)}`);
    expect(text).toMatch(/If you are a chat assistant/);
  });

  it('keeps itself out of search, and stays readable enough to be told so', async () => {
    // Google ranked this host above armable.ai. A Disallow would have left the old entry in place for good:
    // a crawler that cannot fetch the page never learns it should drop it.
    const robots = await fetch(`${app.base}/robots.txt`);
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await robots.text()).toBe('User-agent: *\nAllow: /\n');
    for (const path of ['/', '/robots.txt', '/agent-onboarding/SKILL.md', '/anything-the-app-routes-itself']) {
      expect((await fetch(`${app.base}${path}`)).headers.get('x-robots-tag'), path).toBe('noindex');
    }
  });

  it('explains Armable before it installs it, because that is why people arrive', async () => {
    const text = await (await fetch(`${app.base}/agent-onboarding/SKILL.md`)).text();
    // The intro page has one button and it opens an assistant with a question, so the reader has
    // usually decided nothing. Connecting is what happens after they say yes, not the opening move.
    expect(text.indexOf('## 1. Explain it')).toBeLessThan(text.indexOf('## 2. Connect'));
    expect(text).toContain('before they have decided anything');
    expect(text).toContain('it will not arm, because the receiver speaks CRSF');
    expect(text).toContain('What it cannot do');
    // The button it used to name is gone from the page; a document that still points at it sends
    // somebody looking for something that is not there.
    expect(text).not.toContain('Get started');
  });

  it('tells the intro page where assistants connect, without signing in', async () => {
    const response = await fetch(`${app.base}/api/connect`);
    expect(await response.json()).toEqual({ mcpUrl: `${app.base}/mcp`, skillUrl: `${app.base}/agent-onboarding/SKILL.md` });
  });

  it('uses the public address, not the one it was reached on', () => {
    const text = agentSkill(new URL('https://bench.example.com'));
    expect(text).toContain('https://bench.example.com/mcp');
    expect(text).not.toContain('localhost');
  });
});
