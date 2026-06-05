import { describe, expect, it } from "vitest";
import {
  parsePersistedWorkspaceBoardState,
  serializeWorkspaceBoardState,
  WORKSPACE_BOARD_STATE_VERSION,
  workspaceBoardStorageKey,
} from "@/lib/workspaces/workspace-board-state";

describe("workspace board state model", () => {
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
