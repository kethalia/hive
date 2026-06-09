// Keep in sync with src/lib/constants.ts SAFE_IDENTIFIER_RE
export const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9._-]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PtyConnectionOptions {
  reconnectId: string;
  width: number;
  height: number;
  sessionName: string;
  cwd?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const TMUX_MENU_BINDING_COMMAND = [
  "bind-key -n F12 display-menu -T '#S:#W'",
  "'Copy mode' c 'copy-mode'",
  "'Choose tree' t 'choose-tree -Zw'",
  "''",
  "'Split horizontal' h 'split-window -h'",
  "'Split vertical' v 'split-window -v'",
  "'New window' n 'new-window'",
  "'Rename window' r 'command-prompt -I \"#W\" \"rename-window -- %%\"'",
  "''",
  "'Kill pane' x 'confirm-before -p \"kill-pane #P? (y/n)\" kill-pane'",
].join(" ");

export function buildPtyUrl(
  baseUrl: string,
  agentId: string,
  options: PtyConnectionOptions,
): string {
  const { reconnectId, width, height, sessionName, cwd } = options;

  if (!SAFE_IDENTIFIER_RE.test(sessionName)) {
    throw new Error(`Invalid session name: "${sessionName}" — must match ${SAFE_IDENTIFIER_RE}`);
  }

  let wsBase = baseUrl.replace(/\/+$/, "");
  if (wsBase.startsWith("https://")) {
    wsBase = `wss://${wsBase.slice("https://".length)}`;
  } else if (wsBase.startsWith("http://")) {
    wsBase = `ws://${wsBase.slice("http://".length)}`;
  }

  // tmux -L web new-session -A -s <name>:
  //   -L web    → use a dedicated tmux socket (isolates from user's default tmux)
  //   -A        → attach to session if it exists, create if it doesn't
  //   -s <name> → session name
  // This makes the PTY run inside tmux, so the session survives disconnects.
  // Hide the tmux status bar; the web UI tab manager already shows session
  // names, so the green bar is redundant.
  // Enable tmux mouse support so wheel/trackpad scrolling uses tmux-managed
  // pane history, including output produced before the browser attached.
  // Install the Hive menu binding on every attach so existing tmux servers pick
  // up config changes without needing a server restart.
  const cwdArg = cwd ? ` -c ${shellQuote(cwd)}` : "";
  const command = `tmux -L web ${TMUX_MENU_BINDING_COMMAND} \\; new-session -A -s ${sessionName}${cwdArg} \\; set status off \\; set mouse on`;

  const params = new URLSearchParams({
    reconnect: reconnectId,
    width: String(width),
    height: String(height),
    command,
  });

  return `${wsBase}/api/v2/workspaceagents/${agentId}/pty?${params.toString()}`;
}
