import { describe, expect, it } from "vitest";
import {
  addGitPaneToActiveWorkspaceBoard,
  addTerminalPaneToActiveWorkspaceBoard,
  createWorkspaceBoard,
  deleteWorkspaceBoard,
  removeWorkspaceBoardPane,
  renameActiveWorkspaceBoard,
  renameWorkspaceBoard,
  selectWorkspaceBoard,
  selectWorkspaceBoardPane,
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
      boards: [...baseState().boards, { key: "main-2", name: "Main 2", order: 1, panes: [] }],
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

  it("adds terminal panes to the active board, dedupes by session, and repairs active pane fallback", () => {
    const withPlanning = createWorkspaceBoard(baseState(), "Planning");
    const withWorker = addTerminalPaneToActiveWorkspaceBoard(withPlanning, {
      sessionName: " worker ",
      label: " Worker ",
    });
    const deduped = addTerminalPaneToActiveWorkspaceBoard(withWorker, {
      sessionName: "worker",
      label: "Renamed duplicate should not replace existing membership",
    });
    const selected = selectWorkspaceBoardPane(deduped, "planning", "terminal:worker");
    const removedSelected = removeWorkspaceBoardPane(selected, "planning", "terminal:worker");

    expect(withWorker.activeBoardKey).toBe("planning");
    expect(withWorker.boards[1]).toMatchObject({
      key: "planning",
      activePaneKey: "terminal:worker",
    });
    expect(withWorker.boards[1].panes).toEqual([
      {
        kind: "terminal",
        key: "terminal:worker",
        sessionName: "worker",
        label: "Worker",
        order: 0,
      },
    ]);
    expect(deduped.boards[1].panes).toEqual(withWorker.boards[1].panes);
    expect(selected.boards[1].activePaneKey).toBe("terminal:worker");
    expect(removedSelected.boards[1]).toMatchObject({ key: "planning", panes: [] });
    expect(removedSelected.boards[1].activePaneKey).toBeUndefined();
  });

  it("repairs active pane fallback when removing the selected pane and ignores invalid pane operations", () => {
    const state = addTerminalPaneToActiveWorkspaceBoard(baseState(), {
      sessionName: "worker",
      label: "Worker",
    });
    const selectedWorker = selectWorkspaceBoardPane(state, "main", "terminal:worker");
    const removedWorker = removeWorkspaceBoardPane(selectedWorker, "main", "terminal:worker");
    const blankBoardNoop = removeWorkspaceBoardPane(removedWorker, "   ", "terminal:api");
    const missingPaneNoop = selectWorkspaceBoardPane(removedWorker, "main", "   ");
    const unknownPaneNoop = removeWorkspaceBoardPane(removedWorker, "main", "terminal:missing");

    expect(selectedWorker.boards[0].activePaneKey).toBe("terminal:worker");
    expect(removedWorker.boards[0].activePaneKey).toBe("terminal:api");
    expect(removedWorker.boards[0].panes).toEqual([
      { kind: "terminal", key: "terminal:api", sessionName: "api", label: "API", order: 0 },
    ]);
    expect(blankBoardNoop).toEqual(removedWorker);
    expect(missingPaneNoop).toEqual(removedWorker);
    expect(unknownPaneNoop).toEqual(removedWorker);
  });

  it("adds Git panes with safe metadata and allows the same identity on multiple boards", () => {
    const planning = createWorkspaceBoard(baseState(), "Planning");
    const withGitOnPlanning = addGitPaneToActiveWorkspaceBoard(planning, {
      cloneSessionKey: " git-clone:Git/projects/kethalia/hive ",
      relativePath: " kethalia/hive ",
      sessionName: " git-hive ",
      label: " Hive Repo ",
    });
    const mainSelected = selectWorkspaceBoard(withGitOnPlanning, "main");
    const sharedOnMain = addGitPaneToActiveWorkspaceBoard(mainSelected, {
      cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
      relativePath: "kethalia/hive",
      label: "Hive on Main",
      cloneProof: "proof-should-not-persist",
      clonePath: "/home/coder/projects/kethalia/hive",
    } as Parameters<typeof addGitPaneToActiveWorkspaceBoard>[1]);
    const duplicateGitNoop = addGitPaneToActiveWorkspaceBoard(sharedOnMain, {
      cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
      relativePath: "kethalia/hive",
      label: "Duplicate should not replace existing Git membership",
    });
    const absoluteNoop = addGitPaneToActiveWorkspaceBoard(duplicateGitNoop, {
      cloneSessionKey: "git-clone:absolute",
      relativePath: "/home/coder/projects/kethalia/hive",
      label: "Unsafe absolute",
    });
    const traversalNoop = addGitPaneToActiveWorkspaceBoard(absoluteNoop, {
      cloneSessionKey: "git-clone:traversal",
      relativePath: "kethalia/../hive",
      label: "Unsafe traversal",
    });
    const backslashNoop = addGitPaneToActiveWorkspaceBoard(traversalNoop, {
      cloneSessionKey: "git-clone:backslash",
      relativePath: "kethalia\\hive",
      label: "Unsafe backslash",
    });
    const emptySegmentNoop = addGitPaneToActiveWorkspaceBoard(backslashNoop, {
      cloneSessionKey: "git-clone:empty-segment",
      relativePath: "kethalia//hive",
      label: "Unsafe empty segment",
    });
    const nullByteNoop = addGitPaneToActiveWorkspaceBoard(emptySegmentNoop, {
      cloneSessionKey: "git-clone:null-byte",
      relativePath: "kethalia/hi\0ve",
      label: "Unsafe null byte",
    });
    const missingRefsNoop = addGitPaneToActiveWorkspaceBoard(nullByteNoop, {
      cloneSessionKey: "   ",
      relativePath: "kethalia/hive",
      label: "Missing refs",
    });
    const serialized = serializeWorkspaceBoardState(missingRefsNoop);

    expect(withGitOnPlanning.boards[1].panes).toEqual([
      {
        kind: "git",
        key: "git:git-clone:Git/projects/kethalia/hive:kethalia/hive",
        cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
        relativePath: "kethalia/hive",
        sessionName: "git-hive",
        label: "Hive Repo",
        order: 0,
      },
    ]);
    expect(sharedOnMain.boards[0].panes.map((pane) => [pane.kind, pane.key, pane.order])).toEqual([
      ["terminal", "terminal:api", 0],
      ["git", "git:git-clone:Git/projects/kethalia/hive:kethalia/hive", 1],
    ]);
    expect(sharedOnMain.boards[1].panes).toHaveLength(1);
    expect(duplicateGitNoop).toEqual(sharedOnMain);
    expect(absoluteNoop).toEqual(sharedOnMain);
    expect(traversalNoop).toEqual(sharedOnMain);
    expect(backslashNoop).toEqual(sharedOnMain);
    expect(emptySegmentNoop).toEqual(sharedOnMain);
    expect(nullByteNoop).toEqual(sharedOnMain);
    expect(missingRefsNoop).toEqual(sharedOnMain);
    expect(
      JSON.parse(serialized).boards.flatMap((board: { panes: unknown[] }) => board.panes),
    ).toHaveLength(3);
    expect(serialized).not.toMatch(/cloneProof|clonePath|proof-should-not-persist|\/home\/coder/);
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
