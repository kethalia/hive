import { z } from "zod";
import {
  isExpectedCloneSessionKey,
  isSafeCloneRelativePath,
} from "@/lib/git/clone-public-identifiers";
import {
  parsePersistedWorkspaceBoardState,
  parsePersistedWorkspaceToolPanes,
  workspaceBoardStorageKey,
  workspaceToolPaneStorageKey,
} from "@/lib/workspaces/legacy-workspace-import";
import {
  parseWorkspaceWindowLayoutState,
  reconcileWorkspaceWindowLayout,
  type WorkspaceWindowLayoutNode,
} from "@/lib/workspaces/workspace-window-layout";
import {
  newWindowManager,
  reconcileWindowManager,
  type WindowManager,
  windowManagerSchema,
} from "./window-manager";

export const GENERAL_WORKSPACE_OPEN_EVENT = "hive:workspace-open";
export const HIVE_WINDOW_OPEN_EVENT = "hive:window-open";
export const hiveToolSchema = z.enum([
  "agents",
  "diagnostics",
  "settings",
  "workspaces",
  "templates",
  "logs",
]);
export type HiveTool = z.infer<typeof hiveToolSchema>;
export const hiveToolLabels: Record<HiveTool, string> = {
  templates: "Templates",
  logs: "Logs",
  agents: "Agents",
  diagnostics: "Diagnostics",
  settings: "Settings",
  workspaces: "Coder workspaces",
};
export const hiveWindowRequestSchema = z.object({
  tool: hiveToolSchema,
  workspaceId: z.string().trim().min(1).max(200).optional(),
  launch: z.boolean().optional(),
  sessionName: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,200}$/)
    .optional(),
  template: z.string().min(1).max(200).optional(),
});
export type HiveWindowRequest = z.infer<typeof hiveWindowRequestSchema>;
export function hiveWindowHref(request: HiveWindowRequest) {
  const query = new URLSearchParams({ panel: request.tool });
  if (request.workspaceId) query.set("workspace", request.workspaceId);
  if (request.template) query.set("template", request.template);
  if (request.launch) query.set("launch", "1");
  if (request.sessionName) query.set("session", request.sessionName);
  return `/workspaces?${query}`;
}
export function requestHiveWindow(request: HiveWindowRequest) {
  window.dispatchEvent(new CustomEvent(HIVE_WINDOW_OPEN_EVENT, { detail: request }));
}
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
const hive = z.object({
  sessionName: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,200}$/)
    .optional(),
  kind: z.literal("hive"),
  tool: hiveToolSchema,
  template: identifier.optional(),
  workspaceId: identifier.optional(),
  label: z.string().min(1).max(512),
});
export const generalPaneSchema = z.union([terminal, app, hive]);
export type GeneralPane = z.infer<typeof generalPaneSchema>;
export type GeneralWindow = GeneralPane & { id: string };
export interface GeneralBoard {
  key: string;
  name: string;
  order: number;
  activeWindowId?: string;
  windows: GeneralWindow[];
  layout?: WorkspaceWindowLayoutNode;
  manager?: WindowManager;
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
    boards: [{ key: "board-1", name: "1", order: 0, windows: [], manager: newWindowManager() }],
  };
}
export function generalPaneIdentity(pane: GeneralPane) {
  if (pane.kind === "hive") return JSON.stringify(["hive", pane.tool]);
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
/** Built-in tools have one window across all workspaces. Reopening reveals it in place. */
export function openHiveWindow(
  state: GeneralWorkspaceState,
  request: HiveWindowRequest,
  id: string,
): GeneralWorkspaceState {
  const board = state.boards.find((b) =>
    b.windows.some((w) => w.kind === "hive" && w.tool === request.tool),
  );
  if (!board)
    return addGeneralWindow(
      state,
      {
        kind: "hive",
        tool: request.tool,
        label: hiveToolLabels[request.tool],
        workspaceId: request.workspaceId,
        template: request.template,
        sessionName: request.sessionName,
      },
      id,
    );
  const existing = board.windows.find((w) => w.kind === "hive" && w.tool === request.tool);
  if (!existing) return state;
  return {
    ...state,
    activeBoardKey: board.key,
    boards: state.boards.map((b) =>
      b.key === board.key
        ? {
            ...b,
            activeWindowId: existing.id,
            windows: b.windows.map((w) =>
              w.id === existing.id && w.kind === "hive"
                ? {
                    ...w,
                    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
                    ...(request.template ? { template: request.template } : {}),
                    ...(request.tool === "logs"
                      ? { workspaceId: request.workspaceId, sessionName: request.sessionName }
                      : {}),
                  }
                : w,
            ),
          }
        : b,
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
          manager: newWindowManager(),
        },
      ],
    },
    pane,
    id,
    key,
  );
}
/** Moving onto an already-open target focuses it without discarding either client's state. */
export function moveGeneralWindowToAdjacentBoard(
  state: GeneralWorkspaceState,
  newBoardKey: string,
  direction: -1 | 1,
): GeneralWorkspaceState {
  const index = state.boards.findIndex((b) => b.key === state.activeBoardKey);
  const source = state.boards[index];
  const pane = source?.windows.find((w) => w.id === source.activeWindowId);
  if (!pane) return state;
  const boards =
    state.boards.length === 1
      ? [
          ...state.boards,
          { key: newBoardKey, name: "2", order: 1, windows: [], manager: newWindowManager() },
        ]
      : state.boards;
  const target = boards[(index + direction + boards.length) % boards.length];
  const existing = target.windows.find((w) => generalPaneIdentity(w) === generalPaneIdentity(pane));
  return {
    ...state,
    activeBoardKey: target.key,
    boards: boards.map((b) =>
      b.key === target.key
        ? {
            ...b,
            windows: existing ? b.windows : [...b.windows, pane],
            activeWindowId: existing?.id ?? pane.id,
          }
        : b.key === source.key && !existing
          ? {
              ...b,
              windows: b.windows.filter((w) => w.id !== pane.id),
              activeWindowId: b.windows.find((w) => w.id !== pane.id)?.id,
            }
          : b,
    ),
  };
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
              manager: z.unknown().optional(),
            }),
          )
          .max(MAX_GENERAL_BOARDS),
      })
      .parse(JSON.parse(raw));
    const seenBoards = new Set<string>();
    let remaining = MAX_GENERAL_WINDOWS;
    const globalWindowIds = new Set<string>();
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
          globalWindowIds.has(id.data.id) ||
          seenWindows.has(id.data.id) ||
          seenPanes.has(generalPaneIdentity(pane.data))
        )
          return [];
        seenWindows.add(id.data.id);
        globalWindowIds.add(id.data.id);
        seenPanes.add(generalPaneIdentity(pane.data));
        remaining--;
        return [{ ...pane.data, id: id.data.id }];
      });
      const manager = reconcileWindowManager(
        windowManagerSchema.safeParse(board.manager).data,
        windows.map((w) => w.id),
      );
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
          layout:
            reconcileWorkspaceWindowLayout(
              layout,
              windows.filter((w) => !manager.floating[w.id]).map((w) => w.id),
              { viewportWidth: 1280, viewportHeight: 720 },
            ) ?? undefined,
          manager,
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
// Legacy storage is read once when no general layout exists; it has no active UI.
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
          if (tool.tool === "logs") continue;
          const data = generalPaneSchema.safeParse({
            kind: "app",
            workspaceId,
            tool: tool.tool,
            label: tool.label,
            ...(tool.tool === "files" && tool.filePath
              ? { file: { sessionName: tool.sessionName, path: tool.filePath } }
              : {}),
          });
          if (
            !data.success ||
            windows.some((pane) => generalPaneIdentity(pane) === generalPaneIdentity(data.data))
          )
            continue;
          windows.push({ ...data.data, id: `${key}-${windows.length + 1}` });
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
