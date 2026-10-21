import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: vi.fn() }));

import { spawn } from "node:child_process";
import { runWorkspaceAgentOperation } from "@/lib/agents/workspace";
import { getCoderClientForUser } from "@/lib/coder/user-client";

const user = { id: "hive-user", coderUserId: "coder-owner" };
const client = {
  getWorkspace: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getBaseUrl: () => "https://coder.example.com",
  getSessionToken: () => "private-token",
};

function child(reply: unknown, code = 0) {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  let request = "";
  process.stdin.on("data", (chunk) => {
    request += chunk.toString();
  });
  process.stdin.on("finish", () => {
    process.stdout.write(JSON.stringify(reply));
    process.emit("close", code);
  });
  vi.mocked(spawn).mockReturnValue(process as never);
  return { process, request: () => JSON.parse(request) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCoderClientForUser).mockResolvedValue(client as never);
  client.getWorkspace.mockResolvedValue({
    owner_id: "coder-owner",
    owner_name: "owner",
    name: "dev",
    latest_build: { id: "build", status: "running" },
  });
  client.getWorkspaceResources.mockResolvedValue([
    { agents: [{ id: "agent", name: "main", status: "connected" }] },
  ]);
});

describe("workspace agent operations", () => {
  it("checks ownership before inspecting account or session data", async () => {
    client.getWorkspace.mockResolvedValue({ owner_id: "someone-else" });
    await expect(runWorkspaceAgentOperation(user, "workspace", "inspect")).rejects.toThrow(
      "Only the workspace owner",
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(client.getWorkspaceResources).not.toHaveBeenCalled();
  });

  it("rejects missing owner identity and stopped workspaces", async () => {
    await expect(
      runWorkspaceAgentOperation({ ...user, coderUserId: "" }, "workspace", "inspect"),
    ).rejects.toThrow("Only the workspace owner");
    client.getWorkspace.mockResolvedValue({
      owner_id: "coder-owner",
      latest_build: { status: "stopped" },
    });
    await expect(runWorkspaceAgentOperation(user, "workspace", "resume", "key")).rejects.toThrow(
      "Start this workspace",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses the connected authorized agent and keeps credentials out of argv", async () => {
    const run = child({ ok: true, data: { profile: "software" } });
    expect(await runWorkspaceAgentOperation(user, "workspace", "inspect")).toEqual({
      profile: "software",
    });
    expect(run.request()).toEqual({ operation: "inspect" });
    const call = vi.mocked(spawn).mock.calls[0];
    expect(call[1]).toContain("owner/dev.main");
    expect(JSON.stringify(call[1])).not.toContain("private-token");
    expect(call[2]).toMatchObject({ env: { CODER_SESSION_TOKEN: "private-token" } });
  });

  it("passes only a session key for recovery", async () => {
    const run = child({ ok: true, data: { sessionName: "hive-codex-session" } });
    await runWorkspaceAgentOperation(user, "workspace", "resume", "codex-session");
    expect(run.request()).toEqual({ operation: "resume", key: "codex-session" });
  });

  it("uses repository code for hook installation", async () => {
    const run = child({ ok: true, data: { message: "Installed" } });
    await runWorkspaceAgentOperation(user, "workspace", "install");
    expect(run.request().source).toContain("def track(agent, event):");
  });

  it("does not expose remote errors or configuration values", async () => {
    child({ ok: false, error: "private-token" });
    await expect(runWorkspaceAgentOperation(user, "workspace", "inspect")).rejects.toThrow(
      "Agent operation failed.",
    );
  });
});
