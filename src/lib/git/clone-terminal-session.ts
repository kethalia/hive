export const CLONE_TERMINAL_SESSION_PREFIX = "git-clone-" as const;

export function isCloneTerminalSessionName(sessionName: string): boolean {
  return sessionName.startsWith(CLONE_TERMINAL_SESSION_PREFIX);
}
