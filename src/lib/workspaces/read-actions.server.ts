import type { RegistrationPrincipal } from "@/lib/codex-session/registration.server";
import { WorkspaceReadError } from "./read-contracts";
import { createWorkspaceReadService } from "./read-service.server";
import { filterGenericTmuxSessions, type TmuxSession } from "./sessions";

export function usesWorkspaceReadTransport() {
  return (
    process.env.HIVE_WORKSPACE_READ_ENABLED === "true" ||
    process.env.HIVE_RUNTIME_TARGET === "cloudflare"
  );
}

/** The authenticated action supplies identity; request fields never select an owner. */
export function workspaceReadActions(user: { id: string; coderUserId: string }) {
  const principal: RegistrationPrincipal = { hiveUserId: user.id, coderUserId: user.coderUserId };
  const service = createWorkspaceReadService();
  return {
    async sessions(workspaceId: string): Promise<TmuxSession[]> {
      const signal = AbortSignal.timeout(20_000);
      const sessions: TmuxSession[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      // A bounded aggregate preserves the existing action shape without partial results.
      for (let page = 0; page < 16; page++) {
        const result = await service.read(
          principal,
          workspaceId,
          { operation: "sessions", ...(cursor ? { cursor } : {}) },
          signal,
        );
        sessions.push(...result.sessions);
        if (!result.nextCursor) return filterGenericTmuxSessions(sessions);
        if (seen.has(result.nextCursor)) throw new WorkspaceReadError("invalid_response");
        seen.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new WorkspaceReadError("too_many_sessions");
    },
    async directoryWithBinding(workspaceId: string, sessionName: string) {
      return service.readBound(principal, workspaceId, { operation: "directory", sessionName });
    },
    async directory(workspaceId: string, sessionName: string): Promise<string | null> {
      const result = await service.read(principal, workspaceId, {
        operation: "directory",
        sessionName,
      });
      return result.cwd;
    },
    async paths(input: {
      workspaceId: string;
      sessionName: string;
      fallbackPath?: string;
      paths: string[];
    }): Promise<string[]> {
      const result = await service.read(principal, input.workspaceId, {
        operation: "paths",
        sessionName: input.sessionName,
        ...(input.fallbackPath ? { fallbackPath: input.fallbackPath } : {}),
        paths: input.paths,
      });
      if (
        result.candidates.some(({ status }) =>
          ["outside_supported_root", "cwd_unavailable", "unavailable"].includes(status),
        )
      )
        throw new WorkspaceReadError("read_unavailable");
      return result.candidates
        .filter(({ status }) => status === "file" || status === "directory")
        .map(({ index }) => input.paths[index]);
    },
  };
}
