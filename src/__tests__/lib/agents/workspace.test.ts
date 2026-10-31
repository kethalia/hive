import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("@/lib/coder/user-client", () => ({ getCoderClientForUser: vi.fn() }));
const portable = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/agents/portable-config.server", () => ({
  createPortableAgentService: () => ({ execute: portable.execute }),
}));

import { spawn } from "node:child_process";
import { agentToolsSnapshotSchema } from "@/lib/agents/types";
import { runWorkspaceAgentOperation } from "@/lib/agents/workspace";
import { getCoderClientForUser } from "@/lib/coder/user-client";

const user = { id: "hive-user", coderUserId: "coder-owner" };
const client = {
  getWorkspace: vi.fn(),
  getWorkspaceResources: vi.fn(),
  getBaseUrl: () => "https://coder.example.com",
  getSessionToken: () => "private-token",
};

function child(reply: unknown, code = 0, chunkSize = 16 * 1024) {
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
    const output = Buffer.from(JSON.stringify(reply));
    for (let offset = 0; offset < output.length; offset += chunkSize) {
      process.stdout.write(output.subarray(offset, offset + chunkSize));
    }
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

afterEach(() => vi.unstubAllEnvs());
describe("workspace agent operations", () => {
  it("uses the scoped bridge on Cloudflare without falling back to SSH", async () => {
    vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
    portable.execute.mockResolvedValue({ message: "done" });
    expect(await runWorkspaceAgentOperation(user, "workspace", "install")).toEqual({
      message: "done",
    });
    expect(portable.execute).toHaveBeenCalledWith(
      { hiveUserId: user.id, coderUserId: user.coderUserId },
      "workspace",
      { operation: "install" },
    );
    expect(spawn).not.toHaveBeenCalled();
  });
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

  it("accepts a full snapshot with maximum-length JSON-escaped fields", async () => {
    // Each character requires six bytes in JSON, including Python's ASCII output.
    const escaped = (length: number) => "\u0001".repeat(length);
    const snapshot = agentToolsSnapshotSchema.parse({
      profile: escaped(160),
      checkedAt: 1,
      coderMcpSupported: true,
      typescriptServerInstalled: true,
      agents: ["codex", "claude"].map((agent) => ({
        agent,
        installed: true,
        version: escaped(80),
        auth: "signed-in",
        tracking: true,
        connections: Array.from({ length: 200 }, () => ({
          name: escaped(160),
          enabled: true,
          auth: escaped(160),
        })),
        plugins: Array.from({ length: 100 }, () => ({ name: escaped(160), enabled: true })),
        warnings: Array.from({ length: 10 }, () => escaped(200)),
      })),
      sessions: Array.from({ length: 200 }, (_, index) => {
        const id = `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
        return {
          key: `claude-${id}`,
          id,
          agent: "claude",
          directory: escaped(4096),
          project: escaped(160),
          updatedAt: 1,
          state: "needs-approval",
          running: false,
          directoryExists: true,
        };
      }),
    });
    const reply = { ok: true, data: snapshot };
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeGreaterThan(5 * 1024 * 1024);
    const run = child(reply);
    const result = agentToolsSnapshotSchema.parse(
      await runWorkspaceAgentOperation(user, "workspace", "inspect"),
    );
    expect(result.sessions).toHaveLength(200);
    expect(result.sessions[199].directory).toBe(escaped(4096));
    expect(result.agents[1].connections).toHaveLength(200);
    expect(run.process.kill).not.toHaveBeenCalled();
  });

  it("still kills the SSH process when cumulative output exceeds the limit", async () => {
    const run = child({ ok: true, data: "x".repeat(8 * 1024 * 1024) });
    await expect(runWorkspaceAgentOperation(user, "workspace", "inspect")).rejects.toThrow(
      "Agent tools returned too much data.",
    );
    expect(run.process.kill).toHaveBeenCalled();
  });
});

it("caches inventory but checks ownership and reads live sessions on every inspection", async () => {
  const { inspectWorkspaceAgentTools } = await import("@/lib/agents/workspace");
  const operations: string[] = [];
  const snapshot = {
    profile: "software",
    agents: [],
    sessions: [],
    coderMcpSupported: true,
    typescriptServerInstalled: true,
    checkedAt: 1,
  };
  vi.mocked(spawn).mockImplementation(() => {
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
      const operation = JSON.parse(request).operation;
      operations.push(operation);
      process.stdout.write(
        JSON.stringify({
          ok: true,
          data:
            operation === "install"
              ? { message: "Installed" }
              : { ...snapshot, checkedAt: operations.length },
        }),
      );
      process.emit("close", 0);
    });
    return process as never;
  });
  const first = await inspectWorkspaceAgentTools(user, "cache-test", true);
  const second = await inspectWorkspaceAgentTools(user, "cache-test");
  expect(operations.filter((x) => x === "inventory")).toHaveLength(1);
  expect(operations.filter((x) => x === "sessions")).toHaveLength(2);
  expect(second.checkedAt).toBeGreaterThan(first.checkedAt);
  expect(client.getWorkspace).toHaveBeenCalledTimes(2);
  client.getWorkspace.mockResolvedValueOnce({ owner_id: "other-owner" });
  await expect(inspectWorkspaceAgentTools(user, "cache-test")).rejects.toThrow(
    "Only the workspace owner",
  );
  expect(operations).toHaveLength(3);
  await runWorkspaceAgentOperation(user, "cache-test", "install");
  await inspectWorkspaceAgentTools(user, "cache-test");
  expect(operations.filter((x) => x === "inventory")).toHaveLength(2);
});
