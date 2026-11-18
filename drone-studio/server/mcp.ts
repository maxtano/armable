import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PLAYBOOKS } from '../src/map/library';
import { ToolError, type Services } from './services';
import { INSTRUCTIONS, TOOLS, type ToolContext } from './tools';

export const VERSION = '0.5.0';
/** Hard cap on what a tool may return to a model. Anything larger is a bug in the tool, not something to pass on. */
const MAX_RESULT = 24_000;

/** Build an MCP server bound to one signed-in assistant. One is created per request; it holds no state. */
export function buildMcp(services: Services, identity: { account: string; who: string; scopes?: string[]; clientId?: string }): McpServer {
  const server = new McpServer({ name: 'armable', title: 'Armable', version: VERSION }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = { ...identity, services, now: Date.now };
  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title, description: tool.description, inputSchema: tool.input,
      annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: false },
    }, async (args: Record<string, unknown>) => {
      const started = Date.now();
      const track = (ok: boolean, output: unknown, errorCode?: string) => void services.tracker.toolCall({
        startedAt: started, account: identity.account, assistant: identity.who, clientId: identity.clientId, tool: tool.name, input: args, ok, errorCode, output, durationMs: Date.now() - started, aircraftId: services.currentAircraft(identity.account),
      });
      try {
        const result = await tool.run(args, ctx) as Record<string, unknown>;
        track(true, result.image ? { image: 'omitted' } : result);
        const image = result.image as { mimeType: string; base64: string } | undefined;
        if (image) return { content: [{ type: 'image' as const, data: image.base64, mimeType: image.mimeType }] };
        let text = JSON.stringify(result);
        if (text.length > MAX_RESULT) text = JSON.stringify({ error: { code: 'too_large', message: 'The result was too large to return.', hint: 'Ask for fewer ids, a smaller limit, or detail "summary".' } });
        return { content: [{ type: 'text' as const, text }], structuredContent: text.length > MAX_RESULT ? undefined : result };
      } catch (error) {
        if (!(error instanceof ToolError)) { console.error(`[mcp] ${tool.name} failed`, error); }
        const body = error instanceof ToolError ? { code: error.code, message: error.message, hint: error.hint, ...error.extra } : { code: 'internal', message: 'Armable hit an unexpected error.', hint: 'Try again. If it keeps happening, tell the person.' };
        track(false, { error: body }, body.code);
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: body }) }] };
      }
    });
  }
  // Playbooks double as ready-made prompts, where the assistant app shows them.
  for (const p of PLAYBOOKS.slice(0, 8)) {
    server.registerPrompt(p.id.replace('play.', '').replace(/-/g, '_'), { title: p.symptom, description: `Work through "${p.symptom}" on the connected drone.` }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `My drone: ${p.symptom.toLowerCase()}. Start with get_workspace, then read the playbook ${p.id} and work through it with me.` } }],
    }));
  }
  return server;
}
