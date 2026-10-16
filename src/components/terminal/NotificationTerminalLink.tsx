"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { resolveGitCloneNotificationAction } from "@/lib/actions/git-clones";
import {
  parsePersistedWorkspaceBoardState,
  workspaceBoardStorageKey,
} from "@/lib/workspaces/workspace-board-state";

export function NotificationTerminalLink({
  workspaceId,
  agentId,
  sessionName,
}: {
  workspaceId: string;
  agentId: string;
  sessionName: string;
}) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    void retry;
    let cancelled = false;
    setFailed(false);
    function hasBoard(identity?: { cloneSessionKey: string; clonePath: string }) {
      try {
        const parsed = parsePersistedWorkspaceBoardState(
          window.localStorage.getItem(workspaceBoardStorageKey(workspaceId, "unified")),
        );
        return (
          parsed.status === "valid" &&
          parsed.state.boards.some((board) =>
            board.panes.some(
              (pane) =>
                pane.sessionName === sessionName ||
                (identity &&
                  pane.kind === "git" &&
                  pane.cloneSessionKey === identity.cloneSessionKey &&
                  pane.relativePath === identity.clonePath),
            ),
          )
        );
      } catch {
        return false;
      }
    }
    function openBoard() {
      router.replace(
        `/workspaces/${encodeURIComponent(workspaceId)}/terminal/workspace?${new URLSearchParams({ session: sessionName })}`,
      );
    }
    async function open() {
      try {
        if (!/^[a-zA-Z0-9._-]{1,200}$/.test(sessionName)) throw new Error("Invalid session");
        const query = new URLSearchParams({ session: sessionName });
        if (sessionName.startsWith("git-clone-")) {
          const result = await resolveGitCloneNotificationAction({
            workspaceId,
            agentId,
            sessionName,
          });
          if (cancelled) return;
          const identity = result?.data;
          if (
            !identity ||
            identity.sessionName !== sessionName ||
            !identity.cloneProof ||
            !identity.clonePath ||
            !identity.cloneSessionKey
          )
            throw new Error("Terminal unavailable");
          if (hasBoard(identity)) {
            openBoard();
            return;
          }
          query.set("clonePath", identity.clonePath);
          query.set("cloneProof", identity.cloneProof);
          query.set("cloneSessionKey", identity.cloneSessionKey);
          query.set("relativePath", identity.clonePath);
        }
        if (hasBoard()) {
          openBoard();
          return;
        }
        router.replace(`/workspaces/${encodeURIComponent(workspaceId)}/terminal?${query}`);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void open();
    return () => {
      cancelled = true;
    };
  }, [agentId, retry, router, sessionName, workspaceId]);

  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6 text-center">
      {failed ? (
        <div role="alert" className="max-w-sm space-y-4">
          <p>
            Could not open this terminal. It may have closed, or the workspace may be unavailable.
          </p>
          <Button onClick={() => setRetry((value) => value + 1)}>Try again</Button>
        </div>
      ) : (
        <p role="status">Opening the agent’s terminal…</p>
      )}
    </div>
  );
}
