// ── Workspace naming convention ────────────────────────────────────
//
// Centralises the hive-worker / hive-verifier workspace name derivation
// so the SSE streaming route and the task-queue worker stay in sync.
// Changing a name here is the ONLY place it needs to change.

/** Derive the Coder workspace name for a worker. */
export function workerWorkspaceName(taskId: string): string {
  return `hive-worker-${taskId.slice(0, 8)}`;
}

/** Derive the Coder workspace name for a verifier. */
export function verifierWorkspaceName(taskId: string): string {
  return `hive-verifier-${taskId.slice(0, 8)}`;
}
