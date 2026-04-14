import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/coder/client", () => ({
  CoderClient: vi.fn(),
}));

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

vi.mock("@/lib/safe-action", () => ({
  actionClient: {
    action: (fn: Function) => {
      const bound = async (input?: unknown) => {
        const result = await fn({ parsedInput: input });
        return { data: result };
      };
      return Object.assign(bound, {
        inputSchema: (schema: unknown) => ({
          action: (handler: Function) => {
            return async (input: unknown) => {
              const result = await handler({ parsedInput: input });
              return { data: result };
            };
          },
        }),
      });
    },
    inputSchema: (schema: unknown) => ({
      action: (fn: Function) => {
        return async (input: unknown) => {
          const result = await fn({ parsedInput: input });
          return { data: result };
        };
      },
    }),
  },
}));

import { CoderClient } from "@/lib/coder/client";
import { execInWorkspace } from "@/lib/workspace/exec";

const MockedCoderClient = vi.mocked(CoderClient);
const mockedExec = vi.mocked(execInWorkspace);

describe("session server actions", () => {
  const mockGetWorkspaceAgentName = vi.fn();

  beforeEach(() => {
    vi.stubEnv("CODER_URL", "https://coder.example.com");
    vi.stubEnv("CODER_SESSION_TOKEN", "test-token");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    MockedCoderClient.mockImplementation(() => ({
      getWorkspaceAgentName: mockGetWorkspaceAgentName,
    }) as unknown as InstanceType<typeof CoderClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe("createSessionAction", () => {
    it("creates a session with a provided name", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const { createSessionAction } = await import("@/lib/actions/workspaces");
      const result = await createSessionAction({
        workspaceId: "ws-1",
        sessionName: "my-session",
      });

      expect(mockGetWorkspaceAgentName).toHaveBeenCalledWith("ws-1");
      expect(mockedExec).toHaveBeenCalledWith(
        "dev.main",
        "tmux new-session -d -s my-session",
      );
      expect(result?.data).toEqual({ name: "my-session" });
    });

    it("creates a session with auto-generated name when none provided", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const { createSessionAction } = await import("@/lib/actions/workspaces");
      const result = await createSessionAction({ workspaceId: "ws-1" });

      expect(mockedExec).toHaveBeenCalledWith(
        "dev.main",
        expect.stringMatching(/^tmux new-session -d -s session-\d+$/),
      );
      expect(result?.data?.name).toMatch(/^session-\d+$/);
    });

    it("rejects invalid session names", async () => {
      const { createSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        createSessionAction({
          workspaceId: "ws-1",
          sessionName: "bad name; rm -rf /",
        }),
      ).rejects.toThrow("Invalid session name");
    });

    it("throws when tmux command fails", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "duplicate session: my-session",
        exitCode: 1,
      });

      const { createSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        createSessionAction({
          workspaceId: "ws-1",
          sessionName: "my-session",
        }),
      ).rejects.toThrow('Failed to create session "my-session"');
    });

    it("throws when no agent found", async () => {
      mockGetWorkspaceAgentName.mockRejectedValueOnce(
        new Error("No agents found"),
      );

      const { createSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        createSessionAction({
          workspaceId: "ws-1",
          sessionName: "test",
        }),
      ).rejects.toThrow("No agents found");
    });
  });

  describe("renameSessionAction", () => {
    it("renames a session", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const { renameSessionAction } = await import("@/lib/actions/workspaces");
      const result = await renameSessionAction({
        workspaceId: "ws-1",
        oldName: "old-name",
        newName: "new-name",
      });

      expect(mockedExec).toHaveBeenCalledWith(
        "dev.main",
        "tmux rename-session -t old-name new-name",
      );
      expect(result?.data).toEqual({ oldName: "old-name", newName: "new-name" });
    });

    it("rejects invalid old name", async () => {
      const { renameSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        renameSessionAction({
          workspaceId: "ws-1",
          oldName: "bad name!",
          newName: "good-name",
        }),
      ).rejects.toThrow("Invalid session name: bad name!");
    });

    it("rejects invalid new name", async () => {
      const { renameSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        renameSessionAction({
          workspaceId: "ws-1",
          oldName: "good-name",
          newName: "bad name!",
        }),
      ).rejects.toThrow("Invalid session name: bad name!");
    });

    it("throws when tmux rename fails", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "session not found: old-name",
        exitCode: 1,
      });

      const { renameSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        renameSessionAction({
          workspaceId: "ws-1",
          oldName: "old-name",
          newName: "new-name",
        }),
      ).rejects.toThrow('Failed to rename session "old-name" to "new-name"');
    });

    it("throws when no agent found", async () => {
      mockGetWorkspaceAgentName.mockRejectedValueOnce(
        new Error("No agents found"),
      );

      const { renameSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        renameSessionAction({
          workspaceId: "ws-1",
          oldName: "old",
          newName: "new",
        }),
      ).rejects.toThrow("No agents found");
    });
  });

  describe("killSessionAction", () => {
    it("kills a session", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const { killSessionAction } = await import("@/lib/actions/workspaces");
      const result = await killSessionAction({
        workspaceId: "ws-1",
        sessionName: "my-session",
      });

      expect(mockedExec).toHaveBeenCalledWith(
        "dev.main",
        "tmux kill-session -t my-session",
      );
      expect(result?.data).toEqual({ name: "my-session" });
    });

    it("rejects invalid session name", async () => {
      const { killSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        killSessionAction({
          workspaceId: "ws-1",
          sessionName: "$(evil)",
        }),
      ).rejects.toThrow("Invalid session name");
    });

    it("throws when tmux kill fails", async () => {
      mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
      mockedExec.mockResolvedValueOnce({
        stdout: "",
        stderr: "session not found: my-session",
        exitCode: 1,
      });

      const { killSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        killSessionAction({
          workspaceId: "ws-1",
          sessionName: "my-session",
        }),
      ).rejects.toThrow('Failed to kill session "my-session"');
    });

    it("throws when no agent found", async () => {
      mockGetWorkspaceAgentName.mockRejectedValueOnce(
        new Error("No agents found"),
      );

      const { killSessionAction } = await import("@/lib/actions/workspaces");

      await expect(
        killSessionAction({
          workspaceId: "ws-1",
          sessionName: "test",
        }),
      ).rejects.toThrow("No agents found");
    });
  });
});
