/** A task link pins logical conversation identity across runtime restarts. The
 * server still authenticates every grant and its current build/lifetime. */
export interface ExpectedProjectSession {
  workspaceId: string;
  threadId: string;
}

export function matchesExpectedProjectSession(
  grant: unknown,
  expected: ExpectedProjectSession | undefined,
): boolean {
  if (!expected) return true;
  if (!grant || typeof grant !== "object" || !("binding" in grant)) return false;
  const binding = grant.binding;
  return Boolean(
    binding &&
      typeof binding === "object" &&
      "workspaceId" in binding &&
      binding.workspaceId === expected.workspaceId &&
      "threadId" in binding &&
      binding.threadId === expected.threadId,
  );
}
