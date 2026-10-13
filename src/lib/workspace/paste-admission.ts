// No queue: waiting requests would retain connections/bodies and bypass the memory bound.
// Limits apply to each web process; scaling replicas scales this bounded capacity.
export const TERMINAL_PASTE_MAX_ACTIVE_REQUESTS = 4;
const activeUsers = new Set<string>();

export function acquireTerminalPasteSlot(userId: string): (() => void) | null {
  if (activeUsers.has(userId) || activeUsers.size >= TERMINAL_PASTE_MAX_ACTIVE_REQUESTS) {
    return null;
  }
  activeUsers.add(userId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUsers.delete(userId);
  };
}
