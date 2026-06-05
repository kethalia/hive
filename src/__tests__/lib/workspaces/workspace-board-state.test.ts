import { describe, expect, it } from "vitest";
import type { WorkspaceBoardState } from "@/lib/workspaces/workspace-board-state";
import {
  migrateLegacySessionPaneLayoutToBoardState,
  parsePersistedWorkspaceBoardState,
  resolveWorkspaceBoardState,
  serializeWorkspaceBoardState,
  WORKSPACE_BOARD_STATE_VERSION,
  workspaceBoardStorageKey,
} from "@/lib/workspaces/workspace-board-state";

describe("workspace board state model", () => {
  it("migrates legacy session pane layout JSON into a default board while preserving safe Git metadata", () => {
    const migrated = migrateLegacySessionPaneLayoutToBoardState(
      JSON.stringify({
        version: 1,
        activeSessionName: "git-hive",
        panes: [
          { sessionName: "api", mode: "tiled", order: 1, label: "API" },
          {
            sessionName: "git-hive",
            mode: "floating",
            order: 0,
            label: "Hive Repo",
            cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
            relativePath: "kethalia/hive",
            cloneProof: "do-not-persist",
          },
        ],
      }),
    );

    expect(migrated.status).toBe("valid");
    expect(migrated.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "legacy-layout-migrated",
    ]);
    expect(migrated.state?.activeBoardKey).toBe("default");
    expect(migrated.state?.boards).toHaveLength(1);
    expect(migrated.state?.boards[0]).toMatchObject({
      key: "default",
      name: "Default",
      activePaneKey: "git:git-clone:Git/projects/kethalia/hive",
    });
    expect(migrated.state?.boards[0].panes).toEqual([
      {
        kind: "git",
        key: "git:git-clone:Git/projects/kethalia/hive",
        sessionName: "git-hive",
        label: "Hive Repo",
        cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
        relativePath: "kethalia/hive",
        order: 0,
      },
      {
        kind: "terminal",
        key: "terminal:api",
        sessionName: "api",
        label: "API",
        order: 1,
      },
    ]);
    expect(JSON.stringify(migrated.state)).not.toMatch(/cloneProof|do-not-persist/);
  });

  it("prefers valid current board state over valid legacy layout", () => {
    const state = resolveWorkspaceBoardState({
      persistedBoardJson: JSON.stringify({
        version: WORKSPACE_BOARD_STATE_VERSION,
        activeBoardKey: "current",
        boards: [
          {
            key: "current",
            name: "Current",
            order: 0,
            panes: [{ kind: "terminal", sessionName: "current-api", order: 0 }],
          },
        ],
      }),
      legacyPaneLayoutJson: JSON.stringify({
        version: 1,
        panes: [{ sessionName: "legacy-api", mode: "tiled", order: 0 }],
      }),
      fallbackPanes: [{ sessionName: "current-api" }],
    });

    expect(state.activeBoardKey).toBe("current");
    expect(state.boards[0].panes.map((pane) => pane.key)).toEqual(["terminal:current-api"]);
    expect(state.diagnostics).toEqual([]);
  });

  it("resolves corrupt current state through legacy migration before using fallback panes", () => {
    const state = resolveWorkspaceBoardState({
      persistedBoardJson: "{not-json",
      legacyPaneLayoutJson: JSON.stringify({
        version: 1,
        panes: [{ sessionName: "legacy-worker", mode: "floating", order: 0 }],
      }),
      fallbackPanes: [{ sessionName: "fallback-worker" }],
    });

    expect(state.boards[0].panes.map((pane) => pane.key)).toEqual(["terminal:fallback-worker"]);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "persisted-json-invalid",
      "legacy-layout-migrated",
      "stale-pane-dropped",
      "board-repaired",
    ]);
  });

  it("creates a safe default board from fallback panes when current and legacy persistence are unusable", () => {
    const state = resolveWorkspaceBoardState({
      persistedBoardJson: JSON.stringify({ version: 999, boards: [] }),
      legacyPaneLayoutJson: JSON.stringify({ version: 999, panes: [] }),
      fallbackPanes: [
        { sessionName: "shell", label: "Shell", order: 1 },
        {
          kind: "git",
          sessionName: "git-hive",
          label: "Hive",
          cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
          relativePath: "kethalia/hive",
          order: 0,
        },
      ],
    });

    expect(state.activeBoardKey).toBe("default");
    expect(state.boards).toHaveLength(1);
    expect(state.boards[0]).toMatchObject({ key: "default", name: "Default" });
    expect(state.boards[0].panes.map((pane) => [pane.kind, pane.key, pane.order])).toEqual([
      ["git", "git:git-clone:Git/projects/kethalia/hive", 0],
      ["terminal", "terminal:shell", 1],
    ]);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "persisted-version-unsupported",
      "persisted-version-unsupported",
    ]);
  });

  it("repairs malformed current board state with sanitized diagnostics", () => {
    const state = resolveWorkspaceBoardState({
      persistedBoardJson: JSON.stringify({
        version: WORKSPACE_BOARD_STATE_VERSION,
        activeBoardKey: "missing-board",
        boards: [
          {
            key: "main",
            name: "Main",
            order: 0,
            activePaneKey: "missing-pane",
            panes: [
              "not-a-pane",
              { kind: "terminal", sessionName: " ", order: 0, terminalContents: "secret" },
              { kind: "terminal", sessionName: "api", order: 1 },
              { kind: "terminal", sessionName: "api", order: 2 },
              {
                kind: "git",
                sessionName: "git-evil",
                cloneSessionKey: "git-clone:evil",
                relativePath: "/home/coder/projects/kethalia/hive",
                order: 3,
                cloneProof: "secret-proof",
              },
              { kind: "git", sessionName: "git-missing", cloneSessionKey: "git-clone:missing" },
            ],
          },
          { key: "main", name: "Duplicate", order: 1, panes: [] },
        ],
      }),
      fallbackPanes: [{ sessionName: "api" }],
    });

    expect(state.activeBoardKey).toBe("main");
    expect(state.boards).toHaveLength(1);
    expect(state.boards[0].activePaneKey).toBe("terminal:api");
    expect(state.boards[0].panes).toEqual([
      { kind: "terminal", key: "terminal:api", sessionName: "api", order: 0 },
    ]);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "pane-repaired",
      "pane-repaired",
      "pane-repaired",
      "unsafe-pane-metadata-redacted",
      "pane-repaired",
      "pane-repaired",
      "board-repaired",
      "board-repaired",
    ]);
    expect(JSON.stringify(state.diagnostics)).not.toMatch(
      /secret|secret-proof|terminalContents|cloneProof|\/home\/coder/,
    );
  });

  it("repairs empty current boards to an empty default board without throwing", () => {
    const state = resolveWorkspaceBoardState({
      persistedBoardJson: JSON.stringify({
        version: WORKSPACE_BOARD_STATE_VERSION,
        boards: [],
      }),
    });

    expect(state).toMatchObject({
      version: WORKSPACE_BOARD_STATE_VERSION,
      activeBoardKey: "default",
      boards: [{ key: "default", name: "Default", order: 0, panes: [] }],
    });
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["board-repaired"]);
    expect(() =>
      resolveWorkspaceBoardState({
        persistedBoardJson: JSON.stringify({ version: 1, boards: [] }),
      }),
    ).not.toThrow();
  });

  it("parses a valid current two-board state while preserving active board and pane keys", () => {
    const parsed = parsePersistedWorkspaceBoardState(
      JSON.stringify({
        version: WORKSPACE_BOARD_STATE_VERSION,
        activeBoardKey: "git-work",
        boards: [
          {
            key: "terminal-work",
            name: " Terminal Work ",
            order: 2,
            activePaneKey: "terminal:api",
            panes: [
              {
                kind: "terminal",
                key: "terminal:api",
                sessionName: " api ",
                label: " API ",
                order: 4,
              },
              {
                kind: "git",
                key: "git:hive",
                sessionName: " git-hive ",
                label: " Hive ",
                cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
                relativePath: "kethalia/hive",
                order: 1,
              },
            ],
          },
          {
            key: "git-work",
            name: "Git Work",
            order: 1,
            activePaneKey: "git:hive",
            panes: [
              {
                kind: "git",
                key: "git:hive",
                sessionName: " git-hive ",
                label: " Hive ",
                cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
                relativePath: "kethalia/hive",
                order: 1,
              },
              { kind: "terminal", key: "terminal:worker", sessionName: "worker", order: 1 },
            ],
          },
        ],
      }),
    );

    expect(parsed.status).toBe("valid");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.state?.activeBoardKey).toBe("git-work");
    expect(parsed.state?.boards.map((board) => [board.key, board.name, board.order])).toEqual([
      ["git-work", "Git Work", 0],
      ["terminal-work", "Terminal Work", 1],
    ]);
    expect(parsed.state?.boards[0].activePaneKey).toBe("git:hive");
    expect(parsed.state?.boards[0].panes.map((pane) => [pane.key, pane.kind, pane.order])).toEqual([
      ["git:hive", "git", 0],
      ["terminal:worker", "terminal", 1],
    ]);
  });

  it("normalizes blank names and duplicate order values deterministically", () => {
    const parsed = parsePersistedWorkspaceBoardState(
      JSON.stringify({
        version: WORKSPACE_BOARD_STATE_VERSION,
        activeBoardKey: "second",
        boards: [
          {
            key: "first",
            name: "   ",
            order: 1,
            activePaneKey: "terminal:zsh",
            panes: [
              { kind: "terminal", key: "terminal:zsh", sessionName: " zsh ", order: 3 },
              { kind: "terminal", key: "terminal:api", sessionName: "api", order: 3 },
            ],
          },
          {
            key: "second",
            name: "  Ops  ",
            order: 1,
            activePaneKey: "terminal:worker",
            panes: [{ kind: "terminal", key: "terminal:worker", sessionName: "worker", order: 0 }],
          },
        ],
      }),
    );

    expect(parsed.status).toBe("valid");
    expect(parsed.state?.boards.map((board) => [board.key, board.name, board.order])).toEqual([
      ["first", "Board 1", 0],
      ["second", "Ops", 1],
    ]);
    expect(parsed.state?.boards[0].panes.map((pane) => [pane.key, pane.order])).toEqual([
      ["terminal:zsh", 0],
      ["terminal:api", 1],
    ]);
  });

  it("maps workspace and unified Git sources to stable storage keys", () => {
    expect(workspaceBoardStorageKey("acme", "workspace")).toBe(
      "workspace-board-state:workspace:acme",
    );
    expect(workspaceBoardStorageKey("acme", "unified")).toBe("workspace-board-state:git:acme");
    expect(workspaceBoardStorageKey("acme", "git")).toBe("workspace-board-state:git:acme");
  });

  it("serializes only safe board and terminal or Git pane metadata", () => {
    const parsed = parsePersistedWorkspaceBoardState(
      JSON.stringify({
        version: WORKSPACE_BOARD_STATE_VERSION,
        activeBoardKey: "main",
        accessToken: "do-not-persist",
        boards: [
          {
            key: "main",
            name: "Main",
            order: 0,
            activePaneKey: "git:hive",
            terminalBuffer: "secret terminal text",
            panes: [
              {
                kind: "terminal",
                key: "terminal:api",
                sessionName: "api",
                label: "API",
                order: 0,
                terminalContents: "do-not-persist",
                cwd: "/Users/someone/secret",
              },
              {
                kind: "git",
                key: "git:hive",
                sessionName: "git-hive",
                label: "Hive",
                cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
                relativePath: "kethalia/hive",
                order: 1,
                cloneProof: "do-not-persist",
                clonePath: "/home/coder/projects/kethalia/hive",
                token: "do-not-persist",
              },
            ],
          },
        ],
      }),
    );

    expect(parsed.status).toBe("valid");
    const serialized = serializeWorkspaceBoardState(parsed.state);
    const persisted = JSON.parse(serialized);

    expect(persisted).toEqual({
      version: WORKSPACE_BOARD_STATE_VERSION,
      activeBoardKey: "main",
      boards: [
        {
          key: "main",
          name: "Main",
          order: 0,
          activePaneKey: "git:hive",
          panes: [
            {
              kind: "terminal",
              key: "terminal:api",
              sessionName: "api",
              label: "API",
              order: 0,
            },
            {
              kind: "git",
              key: "git:hive",
              sessionName: "git-hive",
              label: "Hive",
              cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
              relativePath: "kethalia/hive",
              order: 1,
            },
          ],
        },
      ],
    });
    expect(serialized).not.toMatch(
      /terminalContents|terminalBuffer|secret terminal|cwd|cloneProof|clonePath|token|do-not-persist|\/home\/coder|\/Users/,
    );
  });

  it("drops unsafe Git pane path samples and keeps diagnostics sanitized", () => {
    const state = resolveWorkspaceBoardState({
      persistedBoardJson: JSON.stringify({
        version: WORKSPACE_BOARD_STATE_VERSION,
        activeBoardKey: "main",
        boards: [
          {
            key: "main",
            name: "Main",
            order: 0,
            activePaneKey: "terminal:api",
            panes: [
              { kind: "terminal", key: "terminal:api", sessionName: "api", order: 0 },
              {
                kind: "git",
                key: "git:absolute-posix",
                cloneSessionKey: "git-clone:absolute-posix",
                relativePath: "/home/coder/projects/kethalia/hive",
                order: 1,
                cloneProof: "proof-should-not-echo",
                terminalBuffer: "buffer-should-not-echo",
              },
              {
                kind: "git",
                key: "git:home-relative",
                cloneSessionKey: "git-clone:home-relative",
                relativePath: "~/projects/repo",
                order: 2,
                clipboard: "Bearer abc.def.ghi",
                token: "token-should-not-echo",
              },
              {
                kind: "git",
                key: "git:windows-absolute",
                cloneSessionKey: "git-clone:windows-absolute",
                relativePath: "C:\\Users\\repo",
                order: 3,
                cwd: "C:\\Users\\repo",
                secret: "secret-should-not-echo",
              },
              { kind: "git", key: "git:malformed", panes: [{ cloneProof: "nested" }] },
            ],
          },
        ],
      }),
    });

    expect(state.boards[0].panes).toEqual([
      { kind: "terminal", key: "terminal:api", sessionName: "api", order: 0 },
    ]);
    expect(state.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "unsafe-pane-metadata-redacted",
      "pane-repaired",
      "unsafe-pane-metadata-redacted",
      "pane-repaired",
      "unsafe-pane-metadata-redacted",
      "pane-repaired",
      "pane-repaired",
    ]);
    expect(JSON.stringify(state)).not.toMatch(
      /proof-should-not-echo|buffer-should-not-echo|Bearer abc\.def\.ghi|token-should-not-echo|secret-should-not-echo|cloneProof|terminalBuffer|clipboard|cwd|secret|\/home\/coder|~\/projects|C:\\Users/,
    );
  });

  it("serializes forged caller objects through fresh whitelisted objects", () => {
    const terminalPane = {
      kind: "terminal",
      key: "terminal:api",
      sessionName: "api",
      label: "API",
      order: 0,
      terminalBuffer: "terminal-buffer-should-not-persist",
      clipboard: "Bearer abc.def.ghi",
      cwd: "/home/coder/projects/kethalia/hive",
      toJSON: () => {
        throw new Error("source terminal pane should not be stringified");
      },
    };
    const gitPane = {
      kind: "git",
      key: "git:hive",
      sessionName: "git-hive",
      label: "Hive",
      cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
      relativePath: "kethalia/hive",
      order: 1,
      cloneProof: "clone-proof-should-not-persist",
      clonePath: "/home/coder/projects/kethalia/hive",
      token: "token-should-not-persist",
      secret: "secret-should-not-persist",
      toJSON: () => {
        throw new Error("source Git pane should not be stringified");
      },
    };
    const board = {
      key: "main",
      name: "Main",
      order: 0,
      activePaneKey: "git:hive",
      panes: [terminalPane, gitPane],
      cloneProof: "board-proof-should-not-persist",
      terminalBuffer: "board-buffer-should-not-persist",
      token: "board-token-should-not-persist",
      toJSON: () => {
        throw new Error("source board should not be stringified");
      },
    };
    const callerState = {
      version: WORKSPACE_BOARD_STATE_VERSION,
      activeBoardKey: "main",
      boards: [board],
      diagnostics: [],
      secret: "state-secret-should-not-persist",
      toJSON: () => {
        throw new Error("source state should not be stringified");
      },
    } as unknown as WorkspaceBoardState;

    const serialized = serializeWorkspaceBoardState(callerState);
    const persisted = JSON.parse(serialized);

    expect(persisted).toEqual({
      version: WORKSPACE_BOARD_STATE_VERSION,
      activeBoardKey: "main",
      boards: [
        {
          key: "main",
          name: "Main",
          order: 0,
          activePaneKey: "git:hive",
          panes: [
            {
              kind: "terminal",
              key: "terminal:api",
              sessionName: "api",
              label: "API",
              order: 0,
            },
            {
              kind: "git",
              key: "git:hive",
              sessionName: "git-hive",
              label: "Hive",
              cloneSessionKey: "git-clone:Git/projects/kethalia/hive",
              relativePath: "kethalia/hive",
              order: 1,
            },
          ],
        },
      ],
    });
    expect(board.token).toBe("board-token-should-not-persist");
    expect(gitPane.cloneProof).toBe("clone-proof-should-not-persist");
    expect(serialized).not.toMatch(
      /terminal-buffer|Bearer abc\.def\.ghi|cwd|cloneProof|clonePath|clone-proof|token|secret|board-proof|state-secret|\/home\/coder/,
    );
  });

  it("does not throw for unavailable or null input and returns sanitized diagnostics", () => {
    const unavailable = parsePersistedWorkspaceBoardState(null);
    const invalid = parsePersistedWorkspaceBoardState("{not-json");

    expect(unavailable).toEqual({ status: "unavailable", state: null, diagnostics: [] });
    expect(invalid.status).toBe("invalid");
    expect(invalid.state).toBeNull();
    expect(invalid.diagnostics).toEqual([
      {
        code: "persisted-json-invalid",
        message:
          "Stored workspace board state JSON could not be parsed; default board state was used.",
      },
    ]);
    expect(() => parsePersistedWorkspaceBoardState(null)).not.toThrow();
    expect(() => parsePersistedWorkspaceBoardState("{not-json")).not.toThrow();
  });
});
