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

describe("workspace server actions", () => {
  const mockListWorkspaces = vi.fn();
  const mockGetWorkspaceAgentName = vi.fn();
  const mockGetWorkspace = vi.fn();

  beforeEach(() => {
    vi.stubEnv("CODER_URL", "https://coder.example.com");
    vi.stubEnv("CODER_SESSION_TOKEN", "test-token");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    MockedCoderClient.mockImplementation(() => ({
      listWorkspaces: mockListWorkspaces,
      getWorkspaceAgentName: mockGetWorkspaceAgentName,
      getWorkspace: mockGetWorkspace,
    }) as unknown as InstanceType<typeof CoderClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("listWorkspacesAction returns workspace list", async () => {
    const workspaces = [
      { id: "ws-1", name: "dev", owner_name: "alice" },
      { id: "ws-2", name: "prod", owner_name: "alice" },
    ];
    mockListWorkspaces.mockResolvedValueOnce({ workspaces, count: 2 });

    const { listWorkspacesAction } = await import("@/lib/actions/workspaces");
    const result = await listWorkspacesAction();

    expect(mockListWorkspaces).toHaveBeenCalledWith({ owner: "me" });
    expect(result?.data).toEqual(workspaces);
  });

  it("getWorkspaceSessionsAction returns parsed sessions for running workspace", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "main:1712345678:3\ndev:1712345700:1",
      stderr: "",
      exitCode: 0,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(mockGetWorkspaceAgentName).toHaveBeenCalledWith("ws-1");
    expect(mockedExec).toHaveBeenCalledWith(
      "dev.main",
      "tmux list-sessions -F '#{session_name}:#{session_created}:#{session_windows}'",
    );
    expect(result?.data).toEqual([
      { name: "main", created: 1712345678, windows: 3 },
      { name: "dev", created: 1712345700, windows: 1 },
    ]);
  });

  it("getWorkspaceSessionsAction returns empty array when no agents found", async () => {
    mockGetWorkspaceAgentName.mockRejectedValueOnce(
      new Error("No agents found"),
    );

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-no-agents" });

    expect(result?.data).toEqual([]);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it("getWorkspaceAction returns workspace by ID", async () => {
    const workspace = {
      id: "ws-1",
      name: "dev",
      template_id: "tpl-1",
      owner_name: "alice",
      latest_build: {
        id: "build-1",
        status: "running",
        job: { status: "succeeded", error: "" },
      },
    };
    mockGetWorkspace.mockResolvedValueOnce(workspace);

    const { getWorkspaceAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceAction({ workspaceId: "ws-1" });

    expect(mockGetWorkspace).toHaveBeenCalledWith("ws-1");
    expect(result?.data).toEqual(workspace);
  });

  it("getWorkspaceAction propagates client errors", async () => {
    mockGetWorkspace.mockRejectedValueOnce(new Error("Not found"));

    const { getWorkspaceAction } = await import("@/lib/actions/workspaces");

    await expect(getWorkspaceAction({ workspaceId: "ws-missing" })).rejects.toThrow("Not found");
  });

  it("getWorkspaceSessionsAction returns empty array when tmux exits non-zero", async () => {
    mockGetWorkspaceAgentName.mockResolvedValueOnce("dev.main");
    mockedExec.mockResolvedValueOnce({
      stdout: "",
      stderr: "no server running on /tmp/tmux-1000/default",
      exitCode: 1,
    });

    const { getWorkspaceSessionsAction } = await import("@/lib/actions/workspaces");
    const result = await getWorkspaceSessionsAction({ workspaceId: "ws-1" });

    expect(result?.data).toEqual([]);
  });
});
