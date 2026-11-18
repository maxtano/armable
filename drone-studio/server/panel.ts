import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Services } from './services';

/**
 * The Armable panel: Armable's own screen inside Claude or ChatGPT (an MCP App). It opens beside the chat when the
 * assistant first calls get_workspace, shows the drone live, and offers the demo drone or plugging in a real one.
 *
 * It reads everything through panel-only tools, over the assistant's existing, signed-in connection. Those tools
 * are marked for the panel alone (`visibility: ["app"]`), so the assistant never sees or calls them.
 */

export const PANEL_URI = 'ui://armable/panel.html';
export const PANEL_MIME = 'text/html;profile=mcp-app';
/** Marks a tool as the panel's own: hosts don't offer it to the model. */
export const PANEL_ONLY = { ui: { visibility: ['app'] } } as const;
/** Opens the panel with the tool that carries it, in the side panel where the host has one. */
export const PANEL_TOOL_META = { ui: { resourceUri: PANEL_URI }, 'ui/resourceUri': PANEL_URI } as const;

let cached: { dir: string; html: string } | undefined;
/** The panel as one self-contained page: the built script and styles inlined, as MCP Apps require. */
export function panelHtml(staticDir: string | undefined): string {
  const dir = staticDir && resolve(staticDir, 'panel');
  if (cached && cached.dir === dir) return cached.html;
  const js = dir && existsSync(resolve(dir, 'panel.js')) ? readFileSync(resolve(dir, 'panel.js'), 'utf8') : '';
  const css = dir && existsSync(resolve(dir, 'panel.css')) ? readFileSync(resolve(dir, 'panel.css'), 'utf8') : '';
  // A script may contain "</script>", which would end the tag early. Escaping the slash keeps it inert.
  const safe = js.replace(/<\/script/gi, '<\\/script');
  // Armable's typeface, embedded: an MCP App's frame can't fetch it from Armable.
  const fontFile = staticDir && resolve(staticDir, 'fonts', 'manrope-normal-latin.woff2');
  const font = fontFile && existsSync(fontFile) ? `@font-face{font-family:'Manrope';font-style:normal;font-weight:400 800;font-display:swap;src:url(data:font/woff2;base64,${readFileSync(fontFile).toString('base64')}) format('woff2');}` : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Armable</title><style>${font}${css}</style></head>
<body><div id="root">${js ? '' : '<p style="font:14px system-ui;padding:16px">Armable’s panel isn’t built on this server. Open Armable in your browser instead.</p>'}</div>
<script>${safe}</script></body></html>`;
  if (js) cached = { dir: dir!, html };
  return html;
}

export interface PanelState {
  /** An Armable tab, or the server's demo drone, is serving a drone. */
  bench: boolean;
  /** What the drawing needs, and nothing else: it is fetched every second. */
  snapshot?: Record<string, unknown>;
  settings: { id: string; value: unknown }[];
  proposals: { id: string; status: string; part?: string; title: string; changes?: { id: string; title?: string; value: unknown }[]; test?: { id: string; name?: string; args?: Record<string, unknown> } }[];
  /** Where to send someone to plug in a real drone. */
  appUrl: string;
}

/** What the panel shows right now. */
export async function panelState(services: Services, account: string, appUrl: string): Promise<PanelState> {
  const hub = services.hub(account), mirror = hub.mirror, bench = !!hub.benchTab() && !!mirror;
  const proposals = (await services.proposals(account)).filter(p => p.status === 'awaiting_approval' || p.status === 'approved');
  const { logs: _logs, tests: _tests, ...snapshot } = (mirror?.snapshot ?? {}) as Record<string, unknown>;
  return {
    bench,
    snapshot: bench ? snapshot : undefined,
    settings: bench ? mirror!.settings.filter(s => /^esc\.\d+\.direction$/.test(s.id)).map(s => ({ id: s.id, value: s.value })) : [],
    proposals: proposals.map(p => ({
      id: p.id, status: p.status, part: p.part,
      title: p.kind === 'change' ? (p.changes!.length === 1 ? p.changes![0].title ?? p.changes![0].id : `${p.changes!.length} changes`) : `Run ${p.test?.name ?? 'a test'}`,
      changes: p.changes?.map(c => ({ id: c.id, title: c.title, value: c.value })),
      test: p.test && { id: p.test.id, name: p.test.name, args: p.test.args },
    })),
    appUrl,
  };
}
