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
