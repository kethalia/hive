// Read-only import boundary for saved layouts from before the general canvas.
// No legacy renderer, navigation, mutations, credentials, or serialization live here.
import { z } from "zod";

const text = z.string().trim().min(1).max(512);
const pane = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal"), sessionName: text, label: text.optional() }),
  z.object({
    kind: z.literal("git"),
    cloneSessionKey: text,
    relativePath: text,
    sessionName: text.optional(),
    label: text.optional(),
  }),
]);
const board = z.object({ key: text, name: text.default("Imported"), panes: z.array(z.unknown()) });
const tool = z.object({
  boardKey: text,
  sessionName: text,
  tool: z.enum(["files", "code", "logs"]),
  label: text,
  filePath: z.string().startsWith("/").max(4096).optional(),
});
function values(raw: string | null | undefined, field: string): unknown[] {
  try {
    const value = JSON.parse(raw ?? "null");
    return value?.version === 1 && Array.isArray(value[field]) ? value[field] : [];
  } catch {
    return [];
  }
}
export function workspaceBoardStorageKey(workspaceId: string, source: "workspace" | "unified") {
  return `workspace-board-state:${source === "workspace" ? "workspace" : "git"}:${workspaceId}`;
}
export function workspaceToolPaneStorageKey(workspaceId: string, source: "workspace" | "unified") {
  return `workspace-tool-panes:${source}:${workspaceId}`;
}
export function parsePersistedWorkspaceBoardState(raw: string | null) {
  const boards = values(raw, "boards")
    .slice(0, 9)
    .flatMap((value) => {
      const parsed = board.safeParse(value);
      if (!parsed.success) return [];
      return [
        {
          ...parsed.data,
          panes: parsed.data.panes.slice(0, 32).flatMap((value) => {
            const p = pane.safeParse(value);
            return p.success ? [p.data] : [];
          }),
        },
      ];
    });
  return { status: "valid" as const, state: { boards } };
}
export function parsePersistedWorkspaceToolPanes(raw: string | null) {
  return values(raw, "panes")
    .slice(0, 32)
    .flatMap((value) => {
      const p = tool.safeParse(value);
      return p.success ? [p.data] : [];
    });
}
