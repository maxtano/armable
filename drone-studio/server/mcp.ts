import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PLAYBOOKS } from '../src/map/library';
import { ToolError, type Services } from './services';
import { INSTRUCTIONS, TOOLS, gate, type ToolContext } from './tools';
import { PANEL_MIME, PANEL_ONLY, PANEL_TOOL_META, PANEL_URI, panelHtml, panelState } from './panel';
import type { CloudDemos } from './demo';
import { z } from 'zod';

export const VERSION = '0.5.0';
/** Hard cap on what a tool may return to a model. Anything larger is a bug in the tool, not something to pass on. */
const MAX_RESULT = 24_000;

/** Where the Armable panel's built files are, and the address people open Armable at. */
export interface PanelOptions { staticDir?: string; appUrl: string; demos?: CloudDemos }

/** Build an MCP server bound to one signed-in assistant. One is created per request; it holds no state. */
export function buildMcp(services: Services, identity: { account: string; who: string; scopes?: string[]; clientId?: string }, panel: PanelOptions = { appUrl: '/' }): McpServer {
  // The icon assistant apps can show beside "Armable" in their lists of connectors.
  const icon = (size: number) => ({ src: new URL(`/icon-${size}.png`, panel.appUrl).href, mimeType: 'image/png', sizes: [`${size}x${size}`] });
  const server = new McpServer({ name: 'armable', title: 'Armable', version: VERSION, websiteUrl: new URL('/', panel.appUrl).href, icons: [icon(512), icon(192), icon(64)] }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = { ...identity, services, now: Date.now, appUrl: panel.appUrl };
  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title, description: tool.description, inputSchema: tool.input,
      annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: false },
      // The first call opens the Armable panel beside the chat, in hosts that show MCP Apps.
      ...(tool.name === 'get_workspace' ? { _meta: PANEL_TOOL_META } : {}),
    }, async (args: Record<string, unknown>) => {
      const started = Date.now();
      panel.demos?.touch(identity.account);
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
  // The panel: Armable's own screen inside the chat, and the one tool it reads from. The tool is the panel's
  // alone; hosts don't offer it to the model.
  server.registerResource('Armable', PANEL_URI, { title: 'Armable', description: 'Your drone, live, beside the chat.', mimeType: PANEL_MIME }, async () => ({
    contents: [{ uri: PANEL_URI, mimeType: PANEL_MIME, text: panelHtml(panel.staticDir), _meta: { ui: { preferredDisplayMode: 'fullscreen', prefersBorder: false } } }],
  }));
  const panelTool = (name: string, title: string, readOnly: boolean, description: string, input: z.ZodRawShape, run: (args: any) => Promise<unknown>) =>
    server.registerTool(name, { title, description, inputSchema: input, annotations: { title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false }, _meta: PANEL_ONLY }, async (args: Record<string, unknown>) => {
      try {
        await gate(ctx, 0);
        panel.demos?.touch(identity.account);
        await run(args);
        const state = await panelState(services, identity.account, panel.appUrl, panel.demos?.has(identity.account));
        return { content: [{ type: 'text' as const, text: 'Armable panel state.' }], structuredContent: state as unknown as Record<string, unknown> };
      } catch (error) {
        if (!(error instanceof ToolError)) console.error(`[panel] ${name} failed`, error);
        const body = error instanceof ToolError ? { code: error.code, message: error.message, hint: error.hint } : { code: 'internal', message: 'Armable hit an unexpected error.' };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: body }) }] };
      }
    });
  panelTool('armable_panel', 'Armable panel', true, 'For the Armable panel only: what it shows.', {}, async () => {});
  // The demo drone on the server, so the demo works inside the chat with no Armable tab.
  panelTool('armable_demo', 'Start or stop the demo drone', false, 'For the Armable panel only: start or stop the demo drone.', { stop: z.boolean().optional() }, async ({ stop }) => {
    if (!panel.demos) throw new ToolError('unavailable', 'The demo drone runs in the browser here.', 'Open Armable and choose the demo drone.');
    if (stop) panel.demos.stop(identity.account); else await panel.demos.start(identity.account);
  });
  // A person's click in the panel approves a change to the demo drone, and only the demo drone: CloudDemos.approve
  // refuses anything else, so a real drone is only ever approved in Armable itself.
  panelTool('armable_approve', 'Approve a demo drone change', false, 'For the Armable panel only: the person approves a change to the demo drone.', { proposal: z.string().max(40) }, async ({ proposal }) => {
    if (!panel.demos) throw new ToolError('not_demo', 'Approve changes in Armable.');
    const p = await services.proposal(identity.account, proposal);
    await panel.demos.approve(identity.account, proposal, p.needs);
  });
  // Playbooks double as ready-made prompts, where the assistant app shows them.
  for (const p of PLAYBOOKS.slice(0, 8)) {
    server.registerPrompt(p.id.replace('play.', '').replace(/-/g, '_'), { title: p.symptom, description: `Work through "${p.symptom}" on the connected drone.` }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `My drone: ${p.symptom.toLowerCase()}. Start with get_workspace, then read the playbook ${p.id} and work through it with me.` } }],
    }));
  }
  return server;
}
