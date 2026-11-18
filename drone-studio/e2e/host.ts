/**
 * A stand-in for Claude or ChatGPT showing an MCP App: a page with the panel in a frame, answering the panel's
 * requests the way a host does (ui/initialize, tools/call through the assistant's connection, ui/open-link).
 */
export async function hostPanel(page: any, html: string, callTool: (name: string, args: unknown) => Promise<unknown>, context: Record<string, unknown> = {}) {
  const opened: string[] = [], messages: unknown[] = [];
  await page.exposeFunction('hostCallTool', (name: string, args: unknown) => callTool(name, args));
  await page.exposeFunction('hostOpened', (url: string) => { opened.push(url); });
  await page.exposeFunction('hostMessage', (m: unknown) => { messages.push(m); });
  await page.setContent(`<!doctype html><body style="margin:0"><iframe id="app" style="border:0;width:560px;height:900px"></iframe></body>`);
  await page.evaluate(({ html, context }: { html: string; context: Record<string, unknown> }) => {
    const frame = document.getElementById('app') as HTMLIFrameElement;
    window.addEventListener('message', async event => {
      const msg = event.data, target = frame.contentWindow!;
      if (!msg || msg.jsonrpc !== '2.0' || msg.method === undefined || event.source !== target) return;
      const reply = (result: unknown) => target.postMessage({ jsonrpc: '2.0', id: msg.id, result }, '*');
      const w = window as any;
      if (msg.method === 'ui/initialize') reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1.0.0' }, hostCapabilities: { openLinks: {}, serverTools: {}, message: {} }, hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'], ...context } });
      else if (msg.method === 'tools/call') reply(await w.hostCallTool(msg.params.name, msg.params.arguments ?? {}));
      else if (msg.method === 'ui/open-link') { await w.hostOpened(msg.params.url); reply({}); }
      else if (msg.method === 'ui/message') { await w.hostMessage(msg.params); reply({}); }
      else if (msg.method === 'ui/request-display-mode') reply({ mode: msg.params.mode });
      else if (msg.id !== undefined) reply({});
    });
    frame.srcdoc = html;
  }, { html, context });
  return { frame: page.frameLocator('#app'), opened, messages };
}
