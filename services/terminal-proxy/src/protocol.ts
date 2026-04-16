export const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9._-]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PtyConnectionOptions {
  reconnectId: string;
  width: number;
  height: number;
  sessionName: string;
}

export function buildPtyUrl(
  baseUrl: string,
  agentId: string,
  options: PtyConnectionOptions,
): string {
  const { reconnectId, width, height, sessionName } = options;

  if (!SAFE_IDENTIFIER_RE.test(sessionName)) {
    throw new Error(
      `Invalid session name: "${sessionName}" — must match ${SAFE_IDENTIFIER_RE}`,
    );
  }

  let wsBase = baseUrl.replace(/\/+$/, "");
  if (wsBase.startsWith("https://")) {
    wsBase = "wss://" + wsBase.slice("https://".length);
  } else if (wsBase.startsWith("http://")) {
    wsBase = "ws://" + wsBase.slice("http://".length);
  }

  // tmux -L web new-session -A -s <name>:
  //   -L web    → use a dedicated tmux socket (isolates from user's default tmux)
  //   -A        → attach to session if it exists, create if it doesn't
  //   -s <name> → session name
  // This makes the PTY run inside tmux, so the session survives disconnects.
  // Hide the tmux status bar — the web UI tab manager already shows session
  // names, so the green bar is redundant and wastes terminal real estate.
  // status off    → hide green status bar (web UI tab manager already shows names)
  // mouse off     → let xterm.js handle mouse events natively
  // terminal-overrides smcup@:rmcup@ → disable alternate screen so xterm.js
  //   stays in the normal buffer and mouse wheel scrolls the scrollback instead
  //   of being converted to up/down arrow key sequences
  const command = `tmux -L web new-session -A -s ${sessionName} \\; set status off \\; set mouse off \\; set -g terminal-overrides ",xterm*:smcup@:rmcup@"`;

  const params = new URLSearchParams({
    reconnect: reconnectId,
    width: String(width),
    height: String(height),
    command,
  });

  return `${wsBase}/api/v2/workspaceagents/${agentId}/pty?${params.toString()}`;
}
