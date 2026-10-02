export const TERMINAL_SESSION_FORGET_EVENT = "hive:terminal-session-forget";

// Call after explicitly killing or renaming a tmux session. Navigation merely
// parks a terminal; explicit session removal must also release parked clients.
export function forgetTerminalSession(workspaceId: string, sessionName: string): void {
  window.dispatchEvent(
    new CustomEvent(TERMINAL_SESSION_FORGET_EVENT, {
      detail: { workspaceId, sessionName },
    }),
  );
}

export const TERMINAL_VIEWS_FORGET_EVENT = "hive:terminal-views-forget";

export function terminalPaneViewKey(boardKey: string, paneKey: string): string {
  return JSON.stringify([boardKey, paneKey]);
}

// Removing a board or pane closes only its clients, not the underlying tmux
// session or other views of that session.
export function forgetTerminalViews(workspaceId: string, viewKeys: string[]): void {
  window.dispatchEvent(
    new CustomEvent(TERMINAL_VIEWS_FORGET_EVENT, { detail: { workspaceId, viewKeys } }),
  );
}
