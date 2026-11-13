import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: vi.fn() }));
vi.mock("@/lib/workspace/exec", () => ({ execInWorkspace: vi.fn() }));
vi.mock("@/lib/workspace/runtime-artifacts.server", () => ({ readRuntimeArtifact: vi.fn() }));
vi.mock("@/lib/discovery/server-cache", () => ({
  discoveryCacheKey: vi.fn(() => "cache-key"),
  cachedDiscovery: vi.fn(({ load }: { load: () => Promise<unknown> }) => load()),
  invalidateDiscovery: vi.fn(),
}));

import { inspectWorkspaceAgentTools, runWorkspaceAgentOperation } from "@/lib/agents/workspace";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { execInWorkspace } from "@/lib/workspace/exec";
import { readRuntimeArtifact } from "@/lib/workspace/runtime-artifacts.server";

const user = { id: "hive-user", coderUserId: "coder-owner" };
const client = {
  getWorkspace: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getBaseUrl: () => "https://coder.example.com",
  getSessionToken: () => "private-token",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
  vi.mocked(getCoderClientForUser).mockResolvedValue(client as never);
  client.getWorkspace.mockResolvedValue({
    owner_id: user.coderUserId,
    owner_name: "owner",
    name: "dev",
    latest_build: { id: "build", status: "running" },
  });
  client.getWorkspaceResources.mockResolvedValue([
    { agents: [{ id: "agent", name: "main", status: "connected" }] },
  ]);
  vi.mocked(readRuntimeArtifact).mockResolvedValue("# pinned agent-tools script");
  vi.mocked(execInWorkspace).mockResolvedValue({
    stdout: JSON.stringify({ ok: true, data: { message: "Installed" } }),
    stderr: "",
    exitCode: 0,
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("Cloudflare agent tools through authorized workspace PTY", () => {
  it("combines validated inventory and live sessions only after fresh owner authorization", async () => {
    const inventory = {
      profile: "software",
      agents: [],
      coderMcpSupported: true,
      typescriptServerInstalled: true,
    };
    vi.mocked(execInWorkspace).mockImplementation(async (_target, _command, options) => {
      const { operation } = JSON.parse(options?.stdin ?? "");
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          ok: true,
          data: operation === "inventory" ? inventory : { sessions: [], checkedAt: 12 },
        }),
      };
    });
    expect(await inspectWorkspaceAgentTools(user, "workspace", true)).toEqual({
      ...inventory,
      sessions: [],
      checkedAt: 12,
    });
    expect(
      vi
        .mocked(execInWorkspace)
        .mock.calls.map(([, , options]) => JSON.parse(options?.stdin ?? "").operation)
        .sort(),
    ).toEqual(["inventory", "sessions"]);
    expect(
      vi
        .mocked(execInWorkspace)
        .mock.calls.every(
          ([, , options]) =>
            options?.expected?.buildId === "build" && options?.expected?.agentId === "agent",
        ),
    ).toBe(true);
    client.getWorkspace.mockResolvedValue({ owner_id: "other-owner" });
    await expect(inspectWorkspaceAgentTools(user, "workspace")).rejects.toThrow(
      "Only the workspace owner",
    );
    expect(execInWorkspace).toHaveBeenCalledTimes(2);
  });

  it("uses pinned scripts, private stdin and the exact authorized workspace/build/agent", async () => {
    expect(await runWorkspaceAgentOperation(user, "workspace", "install")).toEqual({
      message: "Installed",
    });
    expect(readRuntimeArtifact).toHaveBeenCalledWith("templates/ai-dev-k8s/scripts/agent-tools.py");
    const [target, command, options] = vi.mocked(execInWorkspace).mock.calls[0];
    expect(target).toBe("owner/dev.main");
    expect(command).not.toContain("private-token");
    expect(options).toMatchObject({
      coderUrl: "https://coder.example.com",
      sessionToken: "private-token",
      expected: { workspaceId: "workspace", buildId: "build", agentId: "agent" },
      timeoutMs: 30000,
      maxBufferBytes: 8 * 1024 * 1024,
    });
    expect(JSON.parse(options?.stdin ?? "")).toEqual({
      operation: "install",
      source: "# pinned agent-tools script",
    });
  });
  it("checks ownership before loading scripts or opening a transport", async () => {
    client.getWorkspace.mockResolvedValue({ owner_id: "another-owner" });
    await expect(runWorkspaceAgentOperation(user, "workspace", "inspect")).rejects.toThrow(
      "Only the workspace owner",
    );
    expect(execInWorkspace).not.toHaveBeenCalled();
    expect(readRuntimeArtifact).not.toHaveBeenCalled();
  });
  it("preserves session keys as stdin data and accepts large supported snapshots", async () => {
    const data = { directory: "x".repeat(5 * 1024 * 1024) };
    vi.mocked(execInWorkspace).mockResolvedValueOnce({
      stdout: JSON.stringify({ ok: true, data }),
      stderr: "",
      exitCode: 0,
    });
    expect(await runWorkspaceAgentOperation(user, "workspace", "resume", "codex-session")).toEqual(
      data,
    );
    expect(JSON.parse(vi.mocked(execInWorkspace).mock.calls[0][2]?.stdin ?? "")).toEqual({
      operation: "resume",
      key: "codex-session",
    });
  });
  it.each([
    { exitCode: 1, stdout: "private-token", stderr: "private-token" },
    { exitCode: 0, stdout: '{"ok":false,"error":"private-token"}', stderr: "" },
    { exitCode: 0, stdout: "invalid-json", stderr: "" },
  ])("redacts remote failures", async (result) => {
    vi.mocked(execInWorkspace).mockResolvedValueOnce(result);
    await expect(runWorkspaceAgentOperation(user, "workspace", "inspect")).rejects.toThrow(
      "Agent operation failed. Check the workspace configuration and try again.",
    );
  });
});
