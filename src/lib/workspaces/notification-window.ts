import {
  addGeneralWindow,
  type GeneralPane,
  type GeneralWorkspaceState,
  generalPaneIdentity,
  MAX_GENERAL_BOARDS,
  MAX_GENERAL_WINDOWS,
} from "./general-workspace";
import { newWindowManager, reconcileWindowManager } from "./window-manager";

export function notificationWindowHref(workspaceId: string, sessionName?: string): string {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (sessionName) query.set("session", sessionName);
  return `/workspaces?${query}`;
}
export function openNotificationWindow(
  state: GeneralWorkspaceState,
  pane: GeneralPane,
  id: string,
): GeneralWorkspaceState {
  for (const b of state.boards) {
    const existing = b.windows.find(
      (w) =>
        generalPaneIdentity(w) === generalPaneIdentity(pane) ||
        (w.workspaceId === pane.workspaceId &&
          w.kind === "terminal" &&
          pane.kind === "terminal" &&
          w.sessionName === pane.sessionName),
    );
    if (existing)
      return {
        ...state,
        activeBoardKey: b.key,
        boards: state.boards.map((board) =>
          board.key === b.key
            ? {
                ...board,
                activeWindowId: existing.id,
                manager: {
                  ...reconcileWindowManager(
                    board.manager,
                    board.windows.map((w) => w.id),
                  ),
                  maximized: undefined,
                },
              }
            : board,
        ),
      };
  }
  if (state.boards.reduce((n, b) => n + b.windows.length, 0) >= MAX_GENERAL_WINDOWS)
    throw new Error("Close an unused window before opening this notification.");
  const empty = state.boards.find((b) => !b.windows.length);
  if (empty) return addGeneralWindow(state, pane, id, empty.key);
  if (state.boards.length >= MAX_GENERAL_BOARDS)
    throw new Error("Close an unused board before opening this notification.");
  const key = `notification-${id}`;
  return addGeneralWindow(
    {
      ...state,
      boards: [
        ...state.boards,
        {
          key,
          name: String(state.boards.length + 1),
          order: state.boards.length,
          windows: [],
          manager: newWindowManager(),
        },
      ],
    },
    pane,
    id,
    key,
  );
}
