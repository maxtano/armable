import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSkill } from './onboarding';
import { startApp } from './testkit';

describe('agent onboarding', () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => { await app.close(); });

  it('serves a skill an agent can follow, written for this Lucidity', async () => {
    const response = await fetch(`${app.base}/agent-onboarding/SKILL.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/markdown/);
    const text = await response.text();
    expect(text).toMatch(/^---\nname: lucidity\ndescription: /);
    expect(text).toContain(`claude mcp add --transport http lucidity ${app.base}/mcp`);
    expect(text).toContain('get_workspace');
    expect(text).toContain('Never say a change is done until `wait` returns it done');
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
