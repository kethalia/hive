import { describe, expect, it } from "vitest";
import {
  addGeneralFileWindow,
  addGeneralWindow,
  emptyGeneralWorkspace,
  type GeneralPane,
  generalWorkspaceHref,
  generalWorkspaceStorageKey,
  importLegacyWorkspaceBoards,
  parseGeneralWorkspace,
} from "@/lib/workspaces/general-workspace";
import { workspaceBoardStorageKey } from "@/lib/workspaces/workspace-board-state";
import { workspaceToolPaneStorageKey } from "@/lib/workspaces/workspace-tool-pane-state";

const terminal = (workspaceId: string): GeneralPane => ({
  kind: "terminal",
  workspaceId,
  sessionName: "main",
  label: "Main",
});
describe("general workspace state", () => {
  it("keeps identical session names on different Coder workspaces separate", () => {
    let state = addGeneralWindow(emptyGeneralWorkspace(), terminal("one"), "first");
    state = addGeneralWindow(state, terminal("two"), "second");
    expect(state.boards[0].windows.map((w) => w.workspaceId)).toEqual(["one", "two"]);
    state = addGeneralWindow(state, terminal("one"), "duplicate");
    expect(state.boards[0].windows).toHaveLength(2);
    expect(state.boards[0].activeWindowId).toBe("first");
  });
  it("round-trips mixed app/terminal boards and strips transient credentials", () => {
    let state = addGeneralWindow(emptyGeneralWorkspace(), terminal("one"), "first");
    state = addGeneralWindow(
      state,
      { kind: "app", workspaceId: "two", tool: "desktop", label: "Desktop" },
      "second",
    );
    const raw = JSON.stringify({
      ...state,
      secret: "not-saved",
      boards: state.boards.map((b) => ({
        ...b,
        windows: b.windows.map((w) => ({
          ...w,
          url: "https://untrusted.test/?token=secret",
          cloneProof: "secret",
          agentId: "stale",
        })),
      })),
    });
    const restored = parseGeneralWorkspace(raw);
    expect(restored?.boards[0].windows).toHaveLength(2);
    expect(JSON.stringify(restored)).not.toContain("secret");
    expect(JSON.stringify(restored)).not.toContain("untrusted");
    expect(JSON.stringify(restored)).not.toContain("agentId");
  });
  it("bounds restored windows and rejects malformed selections", () => {
    const state = emptyGeneralWorkspace();
    const raw = JSON.stringify({
      ...state,
      boards: [
        {
          ...state.boards[0],
          windows: [
            ...Array.from({ length: 40 }, (_, i) => ({ ...terminal(String(i)), id: String(i) })),
            { ...terminal("evil"), id: "evil", sessionName: "x; rm -rf" },
          ],
        },
      ],
    });
    expect(parseGeneralWorkspace(raw)?.boards[0].windows).toHaveLength(32);
    expect(parseGeneralWorkspace("{")).toBeNull();
    expect(parseGeneralWorkspace(JSON.stringify({ ...state, version: 99 }))).toBeNull();
  });
  it("imports boards from multiple workspaces without rewriting the legacy store", () => {
    const store = new Map<string, string>();
    for (const id of ["one", "two"])
      store.set(
        workspaceBoardStorageKey(id, "unified"),
        JSON.stringify({
          version: 1,
          activeBoardKey: "old",
          boards: [
            {
              key: "old",
              name: "1",
              order: 0,
              panes: [{ kind: "terminal", key: "main", sessionName: "main", order: 0 }],
            },
          ],
        }),
      );
    const snapshot = [...store];
    const state = importLegacyWorkspaceBoards(["one", "two"], (key) => store.get(key) ?? null);
    expect(state.boards).toHaveLength(2);
    expect(state.boards.flatMap((b) => b.windows.map((w) => w.workspaceId))).toEqual([
      "one",
      "two",
    ]);
    expect([...store]).toEqual(snapshot);
  });
  it.each([
    "workspace",
    "unified",
  ] as const)("preserves distinct legacy file targets and deduplicates complete identities from %s", (source) => {
    const store = new Map<string, string>();
    store.set(
      workspaceBoardStorageKey("one", source),
      JSON.stringify({
        version: 1,
        activeBoardKey: "old",
        boards: [{ key: "old", name: "1", order: 0, panes: [] }],
      }),
    );
    const descriptor = {
      boardKey: "old",
      sessionName: "main",
      tool: "files",
      label: "README.md",
      filePath: "/home/coder/projects/hive/README.md",
    };
    store.set(
      workspaceToolPaneStorageKey("one", source),
      JSON.stringify({
        version: 1,
        panes: [
          { ...descriptor, paneId: "readme" },
          {
            ...descriptor,
            paneId: "index",
            label: "index.ts",
            filePath: "/home/coder/projects/hive/index.ts",
          },
          { ...descriptor, paneId: "duplicate" },
          { ...descriptor, paneId: "other-session", sessionName: "other" },
          { boardKey: "old", sessionName: "main", tool: "files", label: "Files" },
          { boardKey: "old", sessionName: "main", tool: "code", label: "VS Code" },
          { boardKey: "old", sessionName: "main", tool: "logs", label: "Logs" },
          { ...descriptor, paneId: "invalid", sessionName: "bad;session" },
          { ...descriptor, paneId: "other-board", boardKey: "missing" },
        ],
      }),
    );
    const snapshot = [...store];
    const imported = importLegacyWorkspaceBoards(["one"], (key) => store.get(key) ?? null);
    expect(imported.boards).toHaveLength(1);
    expect(imported.boards[0].windows.map(({ id: _id, ...pane }) => pane)).toEqual([
      {
        kind: "app",
        workspaceId: "one",
        tool: "files",
        label: "README.md",
        file: { sessionName: "main", path: descriptor.filePath },
      },
      {
        kind: "app",
        workspaceId: "one",
        tool: "files",
        label: "index.ts",
        file: { sessionName: "main", path: "/home/coder/projects/hive/index.ts" },
      },
      {
        kind: "app",
        workspaceId: "one",
        tool: "files",
        label: "README.md",
        file: { sessionName: "other", path: descriptor.filePath },
      },
      { kind: "app", workspaceId: "one", tool: "files", label: "Files" },
      { kind: "app", workspaceId: "one", tool: "code", label: "VS Code" },
    ]);
    expect(new Set(imported.boards[0].windows.map((pane) => pane.id)).size).toBe(5);
    expect([...store]).toEqual(snapshot);
  });
  it("namespaces layout storage by signed-in user and uses internal app links", () => {
    expect(generalWorkspaceStorageKey("a")).not.toBe(generalWorkspaceStorageKey("b"));
    expect(generalWorkspaceHref("one", "code")).toBe("/workspaces?workspace=one&tool=code");
  });
  it("restores distinct file targets without persisting authorization URLs", () => {
    const file = {
      kind: "app" as const,
      workspaceId: "one",
      tool: "files" as const,
      label: "Files",
      file: { sessionName: "main", path: "src/index.ts" },
    };
    let state = addGeneralWindow(emptyGeneralWorkspace(), file, "one");
    state = addGeneralWindow(state, { ...file, file: { ...file.file, path: "README.md" } }, "two");
    expect(parseGeneralWorkspace(JSON.stringify(state))?.boards[0].windows).toEqual(
      state.boards[0].windows,
    );
    expect(state.boards[0].windows).toHaveLength(2);
  });
  it("opens file links on their source board or a new board and rejects deleted sources", () => {
    const file = {
      kind: "app" as const,
      workspaceId: "one",
      tool: "files" as const,
      label: "Files",
      file: { sessionName: "main", path: "src/index.ts" },
    };
    let state = emptyGeneralWorkspace();
    state.boards.push({ key: "other", name: "2", order: 1, windows: [] });
    state.activeBoardKey = "other";
    state = addGeneralFileWindow(state, file, "board-1", false, "file-1");
    expect(state.activeBoardKey).toBe("board-1");
    expect(state.boards[0].windows[0]).toMatchObject(file);
    state = addGeneralFileWindow(state, file, "board-1", true, "file-2");
    expect(state.activeBoardKey).toBe("board-file-2");
    expect(state.boards[2].windows[0]).toMatchObject(file);
    expect(addGeneralFileWindow(state, file, "deleted", true, "file-3")).toBe(state);
  });
});
