"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveGitCloneNotificationAction } from "@/lib/actions/git-clones";
import { TERMINAL_NOTIFICATION_FOCUS_EVENT } from "@/lib/terminal/events";
import type { GeneralPane, GeneralWorkspaceState } from "@/lib/workspaces/general-workspace";
import { openNotificationWindow } from "@/lib/workspaces/notification-window";

export function useWorkspaceNotifications({
  loaded,
  state,
  update,
  onError,
  onFocus,
}: {
  loaded: boolean;
  state: GeneralWorkspaceState;
  update: (
    change: (state: GeneralWorkspaceState) => GeneralWorkspaceState,
  ) => GeneralWorkspaceState;
  onError: (message: string) => void;
  onFocus: (board: string, id: string) => void;
}) {
  const latest = useRef({ state, update, onError, onFocus });
  latest.current = { state, update, onError, onFocus };
  const generation = useRef(0);
  const [opening, setOpening] = useState(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const open = useCallback(async (workspaceId: string, sessionName: string) => {
    if (!workspaceId || !/^[a-zA-Z0-9._-]{1,200}$/.test(sessionName)) {
      latest.current.onError("This notification has an invalid terminal target.");
      return;
    }
    const request = ++generation.current;
    setOpening(true);
    try {
      let pane: GeneralPane | undefined = latest.current.state.boards
        .flatMap((b) => b.windows)
        .find(
          (w) =>
            w.workspaceId === workspaceId && w.kind === "terminal" && w.sessionName === sessionName,
        );
      if (!pane && sessionName.startsWith("git-clone-")) {
        const result = await resolveGitCloneNotificationAction({ workspaceId, sessionName });
        if (request !== generation.current) return;
        if (!result?.data || result.data.sessionName !== sessionName)
          throw new Error(
            result?.serverError ?? "This repository terminal is no longer available.",
          );
        const { cloneSessionKey, clonePath } = result.data;
        pane = {
          kind: "terminal",
          workspaceId,
          sessionName,
          cloneSessionKey,
          relativePath: clonePath,
          label: clonePath.split("/").pop() ?? sessionName,
        };
      }
      pane ??= { kind: "terminal", workspaceId, sessionName, label: sessionName };
      const target = pane;
      const next = latest.current.update((current) =>
        openNotificationWindow(current, target, crypto.randomUUID()),
      );
      const boardKey = next.activeBoardKey;
      const windowId = next.boards.find((b) => b.key === boardKey)?.activeWindowId;
      if (windowId)
        requestAnimationFrame(() => {
          if (request === generation.current) latest.current.onFocus(boardKey, windowId);
        });
    } catch (error) {
      if (request === generation.current)
        latest.current.onError(
          error instanceof Error ? error.message : "Could not open the notification terminal.",
        );
    } finally {
      if (request === generation.current) setOpening(false);
    }
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const handle = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (typeof detail?.workspaceId !== "string" || typeof detail?.sessionName !== "string")
        return;
      event.preventDefault();
      void open(detail.workspaceId, detail.sessionName);
    };
    window.addEventListener(TERMINAL_NOTIFICATION_FOCUS_EVENT, handle);
    return () => window.removeEventListener(TERMINAL_NOTIFICATION_FOCUS_EVENT, handle);
  }, [loaded, open]);
  return { open, opening };
}
