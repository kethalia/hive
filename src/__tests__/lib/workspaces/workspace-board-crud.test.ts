import { describe, expect, it } from "vitest";
import {
  createWorkspaceBoard,
  deleteWorkspaceBoard,
  renameActiveWorkspaceBoard,
  renameWorkspaceBoard,
  selectWorkspaceBoard,
} from "@/lib/workspaces/workspace-board-crud";
import {
  serializeWorkspaceBoardState,
  WORKSPACE_BOARD_STATE_VERSION,
  type WorkspaceBoardState,
} from "@/lib/workspaces/workspace-board-state";

function baseState(): WorkspaceBoardState {
  return {
    version: WORKSPACE_BOARD_STATE_VERSION,
    activeBoardKey: "main",
    boards: [
      {
        key: "main",
        name: "Main",
        order: 0,
        activePaneKey: "terminal:api",
        panes: [
          { kind: "terminal", key: "terminal:api", sessionName: "api", label: "API", order: 0 },
        ],
      },
    ],
    diagnostics: [],
  };
}

describe("workspace board CRUD helper", () => {
  it("creates a new active board with a persistence-safe state shape", () => {
    const state = baseState();
    const next = createWorkspaceBoard(state, " Planning ");

    expect(next).not.toBe(state);
    expect(next.boards).toHaveLength(2);
    expect(next.activeBoardKey).toBe("planning");
    expect(next.boards.map((board) => [board.key, board.name, board.order])).toEqual([
      ["main", "Main", 0],
      ["planning", "Planning", 1],
    ]);
    expect(next.boards[0].panes).toEqual(state.boards[0].panes);
    expect(next.boards[1]).toMatchObject({ key: "planning", name: "Planning", panes: [] });
    expect(JSON.parse(serializeWorkspaceBoardState(next))).toEqual({
      version: WORKSPACE_BOARD_STATE_VERSION,
      activeBoardKey: "planning",
      boards: [
        {
          key: "main",
          name: "Main",
          order: 0,
          activePaneKey: "terminal:api",
          panes: [
            {
              kind: "terminal",
              key: "terminal:api",
              sessionName: "api",
              label: "API",
              order: 0,
            },
          ],
        },
        { key: "planning", name: "Planning", order: 1, panes: [] },
      ],
    });
  });

  it("selects a known board without changing board or pane membership", () => {
    const created = createWorkspaceBoard(baseState(), "Planning");
    const selected = selectWorkspaceBoard(created, "main");

    expect(selected.activeBoardKey).toBe("main");
    expect(selected.boards).toEqual(created.boards);
    expect(JSON.parse(serializeWorkspaceBoardState(selected))).toMatchObject({
      activeBoardKey: "main",
      boards: [{ key: "main" }, { key: "planning" }],
    });
  });

  it("generates stable unique names and keys for duplicate board names", () => {
    const withDuplicateCandidates: WorkspaceBoardState = {
      ...baseState(),
      boards: [
        ...baseState().boards,
        { key: "main-2", name: "Main 2", order: 1, panes: [] },
      ],
    };

    const next = createWorkspaceBoard(withDuplicateCandidates, " Main ");

    expect(next.activeBoardKey).toBe("main-3");
    expect(next.boards.map((board) => [board.key, board.name, board.order])).toEqual([
      ["main", "Main", 0],
      ["main-2", "Main 2", 1],
      ["main-3", "Main 3", 2],
    ]);
  });

  it("renames a board by key while preserving its stable key and panes", () => {
    const created = createWorkspaceBoard(baseState(), "Planning");
    const renamed = renameWorkspaceBoard(created, "planning", " Delivery ");

    expect(renamed.activeBoardKey).toBe("planning");
    expect(renamed.boards[1]).toMatchObject({ key: "planning", name: "Delivery", panes: [] });
    expect(renamed.boards[0].panes).toEqual(created.boards[0].panes);
  });

  it("renames the active board and repairs duplicate target names deterministically", () => {
    const created = createWorkspaceBoard(baseState(), "Planning");
    const renamed = renameActiveWorkspaceBoard(created, " Main ");

    expect(renamed.activeBoardKey).toBe("planning");
    expect(renamed.boards.map((board) => [board.key, board.name])).toEqual([
      ["main", "Main"],
      ["planning", "Main 2"],
    ]);
  });

  it("treats blank rename and unknown select as no-op repairs", () => {
    const created = createWorkspaceBoard(baseState(), "Planning");
    const blankRenamed = renameWorkspaceBoard(created, "planning", "   ");
    const unknownSelected = selectWorkspaceBoard(created, "missing");

    expect(blankRenamed).toEqual(created);
    expect(unknownSelected).toEqual(created);
  });

  it("deletes the active board and falls back to its nearest neighbor", () => {
    const state = createWorkspaceBoard(createWorkspaceBoard(baseState(), "Planning"), "Review");
    const selected = selectWorkspaceBoard(state, "planning");
    const next = deleteWorkspaceBoard(selected, "planning");

    expect(next.activeBoardKey).toBe("review");
    expect(next.boards.map((board) => [board.key, board.order])).toEqual([
      ["main", 0],
      ["review", 1],
    ]);
    expect(next.boards[0].panes).toEqual(baseState().boards[0].panes);
  });

  it("guards against deleting the final board", () => {
    const state = baseState();
    const next = deleteWorkspaceBoard(state, "main");

    expect(next).toEqual(state);
  });

  it("keeps CRUD output compatible with serializer redaction for hostile caller fields", () => {
    const hostileState = {
      ...baseState(),
      token: "state-token-should-not-persist",
      boards: [
        {
          ...baseState().boards[0],
          cloneProof: "board-proof-should-not-persist",
          panes: [
            {
              kind: "terminal",
              key: "terminal:api",
              sessionName: "api",
              label: "API",
              order: 0,
              terminalBuffer: "buffer-should-not-persist",
              cwd: "/home/coder/projects/kethalia/hive",
              toJSON: () => {
                throw new Error("source pane should not be stringified");
              },
            },
          ],
          toJSON: () => {
            throw new Error("source board should not be stringified");
          },
        },
      ],
      toJSON: () => {
        throw new Error("source state should not be stringified");
      },
    } as unknown as WorkspaceBoardState;

    const next = createWorkspaceBoard(hostileState, "Ops");
    const serialized = serializeWorkspaceBoardState(next);

    expect(JSON.parse(serialized)).toEqual({
      version: WORKSPACE_BOARD_STATE_VERSION,
      activeBoardKey: "ops",
      boards: [
        {
          key: "main",
          name: "Main",
          order: 0,
          activePaneKey: "terminal:api",
          panes: [
            {
              kind: "terminal",
              key: "terminal:api",
              sessionName: "api",
              label: "API",
              order: 0,
            },
          ],
        },
        { key: "ops", name: "Ops", order: 1, panes: [] },
      ],
    });
    expect(serialized).not.toMatch(
      /token|cloneProof|board-proof|terminalBuffer|buffer-should-not-persist|cwd|\/home\/coder/,
    );
  });
});
