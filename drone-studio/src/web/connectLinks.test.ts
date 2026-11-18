import { describe, expect, it } from 'vitest';
import { agentPrompt, claudeCodeCommand, connectOptions, cursorLink, vscodeLink } from './connectLinks';

const MCP = 'https://armable.example/mcp', SKILL = 'https://armable.example/agent-onboarding/SKILL.md';

describe('Connect your AI', () => {
  it('lists Claude first, ChatGPT second, and the agent setup last', () => {
    expect(connectOptions(MCP, SKILL).map(o => o.id)).toEqual(['claude', 'chatgpt', 'claude-code', 'cursor', 'vscode', 'agents']);
  });
  it('copies the Armable address for the web assistants, and opens their connector settings', () => {
    const [claude, chatgpt] = connectOptions(MCP, SKILL);
    expect(claude).toMatchObject({ copy: MCP, href: 'https://claude.ai/customize/connectors' });
    expect(chatgpt).toMatchObject({ copy: MCP });
    expect(chatgpt.href).toMatch(/^https:\/\/chatgpt\.com\//);
  });
  it('builds a Cursor install link with the config base64-encoded', () => {
    const link = new URL(cursorLink(MCP));
    expect(link.protocol).toBe('cursor:');
    expect(link.searchParams.get('name')).toBe('armable');
    expect(JSON.parse(atob(link.searchParams.get('config')!))).toEqual({ url: MCP });
  });
  it('builds a VS Code install link for an HTTP server', () => {
    const link = vscodeLink(MCP);
    expect(link.startsWith('vscode:mcp/install?')).toBe(true);
    expect(JSON.parse(decodeURIComponent(link.slice('vscode:mcp/install?'.length)))).toEqual({ name: 'armable', type: 'http', url: MCP });
  });
  it('gives Claude Code a command and any agent a one-line prompt', () => {
    expect(claudeCodeCommand(MCP)).toBe(`claude mcp add --transport http armable ${MCP}`);
    expect(agentPrompt(SKILL)).toBe(`Read and follow ${SKILL}`);
    const agents = connectOptions(MCP, SKILL).at(-1)!;
    expect(agents).toMatchObject({ id: 'agents', copy: `Read and follow ${SKILL}` });
    expect(agents.href).toBeUndefined();
  });
});
