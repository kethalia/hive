import { z } from "zod";
import {
  isExpectedCloneSessionKey,
  isSafeCloneRelativePath,
} from "@/lib/git/clone-public-identifiers";
import {
  parsePersistedWorkspaceBoardState,
  workspaceBoardStorageKey,
} from "@/lib/workspaces/workspace-board-state";
import {
  parsePersistedWorkspaceToolPanes,
  workspaceToolPaneStorageKey,
} from "@/lib/workspaces/workspace-tool-pane-state";
import {
  parseWorkspaceWindowLayoutState,
  type WorkspaceWindowLayoutNode,
} from "@/lib/workspaces/workspace-window-layout";

export const GENERAL_WORKSPACE_OPEN_EVENT = "hive:workspace-open";
export const MAX_GENERAL_WINDOWS = 32;
export const MAX_GENERAL_BOARDS = 9;
export const generalToolSchema = z.enum(["terminal", "files", "code", "desktop"]);
export type GeneralWorkspaceTool = z.infer<typeof generalToolSchema>;
const identifier = z.string().trim().min(1).max(200);
const terminal = z
  .object({
    kind: z.literal("terminal"),
    workspaceId: identifier,
    sessionName: z.string().regex(/^[a-zA-Z0-9._-]{1,200}$/),
    label: z.string().min(1).max(512),
    cloneSessionKey: z.string().max(512).refine(isExpectedCloneSessionKey).optional(),
    relativePath: z.string().max(512).refine(isSafeCloneRelativePath).optional(),
  })
  .refine((pane) => Boolean(pane.cloneSessionKey) === Boolean(pane.relativePath));
const app = z
  .object({
    kind: z.literal("app"),
    workspaceId: identifier,
    tool: z.enum(["files", "code", "desktop"]),
    label: z.string().min(1).max(512),
    file: z
      .object({
        sessionName: z.string().regex(/^[a-zA-Z0-9._-]{1,200}$/),
        path: z.string().min(1).max(4096),
      })
      .optional(),
  })
  .refine((pane) => !pane.file || pane.tool === "files");
export const generalPaneSchema = z.union([terminal, app]);
export type GeneralPane = z.infer<typeof generalPaneSchema>;
export type GeneralWindow = GeneralPane & { id: string };
export interface GeneralBoard {
  key: string;
  name: string;
  order: number;
  activeWindowId?: string;
  windows: GeneralWindow[];
  layout?: WorkspaceWindowLayoutNode;
}
export interface GeneralWorkspaceState {
  version: 1;
  activeBoardKey: string;
  boards: GeneralBoard[];
}
export function generalWorkspaceStorageKey(userId: string) {
  return `general-workspace:v1:${userId}`;
}
export function emptyGeneralWorkspace(): GeneralWorkspaceState {
  return {
    version: 1,
    activeBoardKey: "board-1",
    boards: [{ key: "board-1", name: "1", order: 0, windows: [] }],
  };
}
export function generalPaneIdentity(pane: GeneralPane) {
  return JSON.stringify([
    pane.workspaceId,
    pane.kind,
    pane.kind === "app" ? pane.tool : (pane.cloneSessionKey ?? pane.sessionName),
    pane.kind === "app" ? pane.file : undefined,
  ]);
}
export function addGeneralWindow(
  state: GeneralWorkspaceState,
  pane: GeneralPane,
  id: string,
  boardKey = state.activeBoardKey,
): GeneralWorkspaceState {
  const board = state.boards.find((item) => item.key === boardKey);
  if (!board) return state;
  const existing = board.windows.find(
    (item) => generalPaneIdentity(item) === generalPaneIdentity(pane),
  );
  if (
    !existing &&
    state.boards.reduce((count, item) => count + item.windows.length, 0) >= MAX_GENERAL_WINDOWS
  )
    return state;
  return {
    ...state,
    activeBoardKey: board.key,
    boards: state.boards.map((item) =>
      item.key === board.key
        ? {
            ...item,
            activeWindowId: existing?.id ?? id,
            windows: existing ? item.windows : [...item.windows, { ...pane, id }],
          }
        : item,
    ),
  };
}
// Keep file requests on the originating board even if focus changes during an action.
export function addGeneralFileWindow(
  state: GeneralWorkspaceState,
  pane: Extract<GeneralPane, { kind: "app" }>,
  sourceBoardKey: string,
  newBoard: boolean,
  id: string,
): GeneralWorkspaceState {
  if (!state.boards.some((board) => board.key === sourceBoardKey)) return state;
  if (state.boards.reduce((count, board) => count + board.windows.length, 0) >= MAX_GENERAL_WINDOWS)
    return state;
  if (!newBoard) return addGeneralWindow(state, pane, id, sourceBoardKey);
  if (state.boards.length >= MAX_GENERAL_BOARDS) return state;
  const key = `board-${id}`;
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
        },
      ],
    },
    pane,
    id,
    key,
  );
}
export function parseGeneralWorkspace(raw: string | null): GeneralWorkspaceState | null {
  if (!raw) return null;
  try {
    const data = z
      .object({
        version: z.literal(1),
        activeBoardKey: identifier,
        boards: z
          .array(
            z.object({
              key: identifier,
              name: identifier,
              order: z.number().finite(),
              activeWindowId: identifier.optional(),
              windows: z.array(z.unknown()),
              layout: z.unknown().optional(),
            }),
          )
          .max(MAX_GENERAL_BOARDS),
      })
      .parse(JSON.parse(raw));
    const seenBoards = new Set<string>();
    let remaining = MAX_GENERAL_WINDOWS;
    const boards = data.boards.flatMap((board) => {
      if (seenBoards.has(board.key)) return [];
      seenBoards.add(board.key);
      const seenWindows = new Set<string>();
      const seenPanes = new Set<string>();
      const windows = board.windows.flatMap((value) => {
        const pane = generalPaneSchema.safeParse(value);
        const id = z.object({ id: identifier }).safeParse(value);
        if (
          !pane.success ||
          !id.success ||
          !remaining ||
          seenWindows.has(id.data.id) ||
          seenPanes.has(generalPaneIdentity(pane.data))
        )
          return [];
        seenWindows.add(id.data.id);
        seenPanes.add(generalPaneIdentity(pane.data));
        remaining--;
        return [{ ...pane.data, id: id.data.id }];
      });
      const layout = parseWorkspaceWindowLayoutState(
        JSON.stringify({ version: 1, boards: [{ boardKey: board.key, root: board.layout }] }),
      ).boards[0]?.root;
      return [
        {
          key: board.key,
          name: board.name,
          order: board.order,
          activeWindowId: windows.some((w) => w.id === board.activeWindowId)
            ? board.activeWindowId
            : windows[0]?.id,
          windows,
          layout,
        },
      ];
    });
    if (!boards.length) return null;
    return {
      version: 1,
      activeBoardKey: boards.some((b) => b.key === data.activeBoardKey)
        ? data.activeBoardKey
        : boards[0].key,
      boards,
    };
  } catch {
    return null;
  }
}

// Import saved pane descriptors, never app URLs, auth redirects, agent IDs, or clone proofs.
// The old per-workspace layouts remain untouched for existing deep links.
export function importLegacyWorkspaceBoards(
  workspaceIds: string[],
  read: (key: string) => string | null,
): GeneralWorkspaceState {
  let state = emptyGeneralWorkspace();
  const boards: GeneralBoard[] = [];
  for (const workspaceId of workspaceIds) {
    for (const source of ["unified", "workspace"] as const) {
      const parsed = parsePersistedWorkspaceBoardState(
        read(workspaceBoardStorageKey(workspaceId, source)),
      );
      if (parsed.status !== "valid") continue;
      const tools = parsePersistedWorkspaceToolPanes(
        read(workspaceToolPaneStorageKey(workspaceId, source)),
      );
      for (const old of parsed.state.boards) {
        if (boards.length >= MAX_GENERAL_BOARDS) break;
        const key = `import-${boards.length + 1}`;
        const windows: GeneralWindow[] = [];
        for (const pane of old.panes) {
          const data = generalPaneSchema.safeParse(
            pane.kind === "git"
              ? {
                  kind: "terminal",
                  workspaceId,
                  sessionName: pane.sessionName ?? "pending-clone",
                  label: pane.label ?? pane.relativePath,
                  cloneSessionKey: pane.cloneSessionKey,
                  relativePath: pane.relativePath,
                }
              : {
                  kind: "terminal",
                  workspaceId,
                  sessionName: pane.sessionName,
                  label: pane.label ?? pane.sessionName,
                },
          );
          if (data.success) windows.push({ ...data.data, id: `${key}-${windows.length + 1}` });
        }
        for (const tool of tools.filter(
          (tool) => tool.boardKey === old.key && tool.tool !== "logs",
        )) {
          if (windows.some((p) => p.kind === "app" && p.tool === tool.tool)) continue;
          if (tool.tool === "logs") continue;
          windows.push({
            id: `${key}-${windows.length + 1}`,
            kind: "app",
            workspaceId,
            tool: tool.tool,
            label: tool.tool === "code" ? "VS Code" : "Files",
          });
        }
        if (windows.length)
          boards.push({
            key,
            name: old.name,
            order: boards.length,
            windows,
            activeWindowId: windows[0]?.id,
          });
      }
    }
  }
  if (boards.length) state = { version: 1, activeBoardKey: boards[0].key, boards };
  return parseGeneralWorkspace(JSON.stringify(state)) ?? emptyGeneralWorkspace();
}
export function generalWorkspaceHref(workspaceId: string, tool?: GeneralWorkspaceTool) {
  const query = new URLSearchParams({ workspace: workspaceId });
  if (tool) query.set("tool", tool);
  return `/workspaces?${query}`;
}
