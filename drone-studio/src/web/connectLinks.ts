/**
 * One-click ways to add Armable to an assistant. Each entry either opens the assistant (a deep link, or its
 * connector settings) or copies something to paste. The Armable address is copied along the way, because the
 * web assistants have no link that pre-fills a custom connector.
 */
export type ConnectTarget = 'claude' | 'chatgpt' | 'claude-code' | 'cursor' | 'vscode' | 'agents';
export interface ConnectOption {
  id: ConnectTarget;
  name: string;
  /** Opened in a new tab or handed to the installed app. */
  href?: string;
  /** Put on the clipboard when chosen. */
  copy: string;
  /** What to do next, shown once the option is chosen. */
  next: string;
}

const NAME = 'armable';
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

export const cursorLink = (mcpUrl: string) => `cursor://anysphere.cursor-deeplink/mcp/install?name=${NAME}&config=${encodeURIComponent(base64(JSON.stringify({ url: mcpUrl })))}`;
export const vscodeLink = (mcpUrl: string) => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: NAME, type: 'http', url: mcpUrl }))}`;
export const claudeCodeCommand = (mcpUrl: string) => `claude mcp add --transport http ${NAME} ${mcpUrl}`;
export const agentPrompt = (skillUrl: string) => `Read and follow ${skillUrl}`;

export function connectOptions(mcpUrl: string, skillUrl: string): ConnectOption[] {
  return [
    { id: 'claude', name: 'Claude', href: 'https://claude.ai/customize/connectors', copy: mcpUrl,
      next: 'Address copied. In Claude: Add custom connector, paste it, then sign in to Armable when asked.' },
    { id: 'chatgpt', name: 'ChatGPT', href: 'https://chatgpt.com/#settings/Connectors', copy: mcpUrl,
      next: 'Address copied. In ChatGPT: Settings, Connectors, Create. Paste it, then sign in to Armable when asked.' },
    { id: 'claude-code', name: 'Claude Code', copy: claudeCodeCommand(mcpUrl),
      next: 'Command copied. Run it in a terminal, then /mcp in Claude Code to sign in.' },
    { id: 'cursor', name: 'Cursor', href: cursorLink(mcpUrl), copy: mcpUrl,
      next: 'Cursor opens to add Armable. Sign in to Armable when it asks.' },
    { id: 'vscode', name: 'VS Code', href: vscodeLink(mcpUrl), copy: mcpUrl,
      next: 'VS Code opens to add Armable. Sign in to Armable when it asks.' },
    { id: 'agents', name: 'Setup for agents', copy: agentPrompt(skillUrl),
      next: 'Copied. Paste it into any agent: it sets itself up from Armable’s instructions.' },
  ];
}
