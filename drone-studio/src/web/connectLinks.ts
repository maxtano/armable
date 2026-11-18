/**
 * One-click ways to add Armable to an assistant. Each entry opens the assistant with Armable filled in where it
 * can (Claude, Cursor, VS Code), or copies what to paste where it can't (ChatGPT, Claude Code, any agent).
 */
export type ConnectTarget = 'claude' | 'chatgpt' | 'claude-code' | 'cursor' | 'vscode' | 'agents';
export interface ConnectOption {
  id: ConnectTarget;
  name: string;
  /** Opened in a window beside Armable, or handed to the installed app. */
  href?: string;
  /** Open href in a window on the left half of the screen, so the assistant and Armable sit side by side. */
  beside?: boolean;
  /** Put on the clipboard when chosen. */
  copy: string;
  /** What the person does next, in order. The step that needs Armable's sign-in is detected and ticked. */
  steps: string[];
}

const NAME = 'armable';
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** Claude's documented install link: opens “Add custom connector” with the name and address filled in. */
export const claudeInstallLink = (mcpUrl: string) => `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Armable&connectorUrl=${encodeURIComponent(mcpUrl)}`;
export const cursorLink = (mcpUrl: string) => `cursor://anysphere.cursor-deeplink/mcp/install?name=${NAME}&config=${encodeURIComponent(base64(JSON.stringify({ url: mcpUrl })))}`;
export const vscodeLink = (mcpUrl: string) => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: NAME, type: 'http', url: mcpUrl }))}`;
/** A new Claude chat with a message typed in, ready to send (Claude's `q` parameter). */
export const claudeChatLink = (message: string) => `https://claude.ai/new?q=${encodeURIComponent(message)}`;
export const claudeCodeCommand = (mcpUrl: string) => `claude mcp add --transport http ${NAME} ${mcpUrl}`;
export const agentPrompt = (skillUrl: string) => `Read and follow ${skillUrl}`;

const SIGN_IN = 'Sign in to Armable when it asks, and press Allow.';

export function connectOptions(mcpUrl: string, skillUrl: string): ConnectOption[] {
  return [
    { id: 'claude', name: 'Claude', href: claudeInstallLink(mcpUrl), beside: true, copy: mcpUrl,
      steps: ['Claude opens on the left with Armable filled in. Click Add.', SIGN_IN, 'Start a new chat in Claude and say “Check my drone”.'] },
    { id: 'chatgpt', name: 'ChatGPT', href: 'https://chatgpt.com/#settings/Connectors', beside: true, copy: mcpUrl,
      steps: ['ChatGPT opens on the left. Under Apps & Connectors, Advanced, turn on Developer mode (once; needs Plus or Pro).', 'Choose Create. Name it Armable, paste the address (already copied), and pick OAuth.', SIGN_IN, 'In a new chat, add Armable from the + menu and say “Check my drone”.'] },
    { id: 'claude-code', name: 'Claude Code', copy: claudeCodeCommand(mcpUrl),
      steps: ['Command copied. Paste it in a terminal.', 'In Claude Code, run /mcp and choose armable.', SIGN_IN] },
    { id: 'cursor', name: 'Cursor', href: cursorLink(mcpUrl), copy: mcpUrl,
      steps: ['Cursor opens to add Armable. Confirm it.', SIGN_IN] },
    { id: 'vscode', name: 'VS Code', href: vscodeLink(mcpUrl), copy: mcpUrl,
      steps: ['VS Code opens to add Armable. Confirm it.', SIGN_IN] },
    { id: 'agents', name: 'Any other agent', copy: agentPrompt(skillUrl),
      steps: ['Setup prompt copied. Paste it into your agent: it reads Armable’s instructions and connects itself.', SIGN_IN] },
  ];
}

/**
 * Open a window on one half of the screen: the assistant on the left, Armable on the right. Returns null when the
 * browser blocks it. The caller keeps the window so it can send it to a new chat once connected, which needs the
 * window to stay linked to this tab; only Claude's and ChatGPT's own sites are ever opened this way.
 */
export function openBeside(url: string, side: 'left' | 'right' = 'left'): Window | null {
  const s = screen as Screen & { availLeft?: number; availTop?: number };
  const width = Math.max(420, Math.round(s.availWidth / 2)), height = s.availHeight;
  const left = (s.availLeft ?? 0) + (side === 'right' ? s.availWidth - width : 0);
  const win = window.open(url, side === 'left' ? 'armable-assistant' : 'armable-bench', `popup,width=${width},height=${height},left=${left},top=${s.availTop ?? 0}`);
  win?.focus();
  return win;
}
