// Keep in sync with src/lib/constants.ts SAFE_IDENTIFIER_RE
export const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9._-]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PtyConnectionOptions {
  reconnectId: string;
  width: number;
  height: number;
  sessionName: string;
  cwd?: string;
  audioRelay?: boolean;
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
  // Advertise the browser terminal's actual capabilities to this client. Forward
  // application OSC 52 copies and negotiated modified keys through the web server.
  const cwdArg = cwd ? ` -c ${shellQuote(cwd)}` : "";
  // New sessions inherit their own virtual devices even when the tmux server
  // predates this attachment. Existing shells keep their environment until
  // restarted. Older images remain usable without the audio helper.
  const audioEnvironment = `if command -v hive-audio >/dev/null 2>&1 && hive_audio_server="$(hive-audio prepare ${shellQuote(sessionName)})"; then export PULSE_SERVER="$hive_audio_server"; fi; `;
  const command = options.audioRelay
    ? `if command -v hive-audio >/dev/null 2>&1; then exec hive-audio relay ${shellQuote(sessionName)}; else printf '%s\\n' '{"type":"error","message":"Workspace audio is unavailable. Update the workspace image and open a new terminal."}'; fi`
    : `${audioEnvironment}tmux -L web -T clipboard,hyperlinks,RGB,extkeys set -s set-clipboard on \\; set -s extended-keys on \\; ${TMUX_MENU_BINDING_COMMAND} \\; new-session -A -e "PULSE_SERVER=\${PULSE_SERVER:-}" -s ${sessionName}${cwdArg} \\; set status off \\; set mouse on`;

  const params = new URLSearchParams({
    reconnect: reconnectId,
    width: String(width),
    height: String(height),
    command,
  });

  return `${wsBase}/api/v2/workspaceagents/${agentId}/pty?${params.toString()}`;
}
