import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), artifact: vi.fn() }));
vi.mock("@/lib/workspace/exec", () => ({ execInWorkspace: mocks.exec }));
vi.mock("@/lib/workspace/runtime-artifacts.server", () => ({
  readRuntimeArtifact: mocks.artifact,
}));

import { installNotificationHooks } from "@/lib/push/install";
import { callbackTokenHash } from "@/lib/push/source-credentials";

const prepared = {
  client: {
    getBaseUrl: () => "https://coder.invalid",
    getSessionToken: () => "scoped-coder-fixture",
  },
  target: "owner/workspace.main",
  workspaceName: "workspace",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  buildId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
} as Awaited<ReturnType<typeof import("@/lib/push/install").prepareNotificationWorkspace>>;
const version = {
  sourceId: "44444444-4444-4444-8444-444444444444",
  generation: 1,
  createdAt: "2026-11-13T00:00:00.000Z",
};
const token = "a".repeat(64);
const url = "https://hive.invalid/api/notifications/events";
const receipt = {
  ...version,
  credentialHash: callbackTokenHash(token),
  callbackOrigin: "https://hive.invalid",
};
const homes: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HIVE_RUNTIME_TARGET", "cloudflare");
  mocks.artifact.mockImplementation((path: string) => readFile(path, "utf8"));
  mocks.exec.mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, data: receipt }),
    stderr: "",
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
describe("Worker notification installation", () => {
  it("keeps callback/Coder secrets out of the command and pins the prechecked workspace/build/agent", async () => {
    expect(await installNotificationHooks(prepared, url, token, version)).toBe("workspace");
    const [target, command, options] = mocks.exec.mock.calls[0];
    expect(target).toBe(prepared.target);
    expect(command).toContain("python3 -c");
    expect(command).not.toContain(token);
    expect(command).not.toContain("scoped-coder-fixture");
    expect(JSON.parse(options.stdin)).toMatchObject({ token, url, ...version, portable: true });
    expect(options).toMatchObject({
      timeoutMs: 20000,
      maxBufferBytes: 4096,
      expected: {
        workspaceId: prepared.workspaceId,
        buildId: prepared.buildId,
        agentId: prepared.agentId,
      },
    });
  });
  it.each([
    { ...receipt, generation: 2 },
    { ...receipt, sourceId: "foreign-source" },
    { ...receipt, credentialHash: "b".repeat(64) },
    { ...receipt, callbackOrigin: "https://foreign.invalid" },
    { ...receipt, createdAt: "2026-11-14T00:00:00.000Z" },
  ])("holds a mismatched installer receipt", async (data) => {
    mocks.exec.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, data }),
      stderr: token,
    });
    await expect(installNotificationHooks(prepared, url, token, version)).rejects.toThrow(
      "setup_outcome_unknown",
    );
  });
  it("retains uncertainty on incomplete output, nonzero exit and cancellation", async () => {
    for (const result of [
      { exitCode: 0, stdout: "{", stderr: token },
      { exitCode: 124, stdout: "", stderr: token },
    ]) {
      mocks.exec.mockResolvedValueOnce(result);
      await expect(installNotificationHooks(prepared, url, token, version)).rejects.toThrow(
        "setup_outcome_unknown",
      );
    }
    const controller = new AbortController();
    mocks.exec.mockImplementationOnce(async () => {
      controller.abort();
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, data: receipt }) };
    });
    await expect(
      installNotificationHooks(prepared, url, token, version, controller.signal),
    ).rejects.toThrow();
  });
  it("runs the actual Python installer and replays the same generation without duplicate hooks", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-notification-worker-"));
    homes.push(home);
    mocks.exec.mockImplementation(async (_target, command: string, options) => {
      return new Promise((resolve, reject) => {
        const child = spawn("sh", ["-c", command], {
          env: {
            ...process.env,
            HOME: home,
            CODEX_HOME: join(home, ".codex"),
            CLAUDE_CONFIG_DIR: join(home, ".claude"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (part) => {
          stdout += part;
        });
        child.stderr.on("data", (part) => {
          stderr += part;
        });
        child.on("error", reject);
        child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
        child.stdin.end(options.stdin);
      });
    });
    await installNotificationHooks(prepared, url, token, version);
    await installNotificationHooks(prepared, url, token, version);
    const config = JSON.parse(await readFile(join(home, ".codex/hooks.json"), "utf8"));
    expect(config.hooks.Stop).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(home, ".local/share/hive/notifications/config.json"), "utf8")),
    ).toMatchObject({ token, ...version });
    await expect(installNotificationHooks(prepared, url, "b".repeat(64), version)).rejects.toThrow(
      "setup_outcome_unknown",
    );
    expect(
      JSON.parse(await readFile(join(home, ".local/share/hive/notifications/config.json"), "utf8")),
    ).toMatchObject({ token });
  });
});
