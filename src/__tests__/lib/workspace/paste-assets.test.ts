import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecInWorkspace = vi.hoisted(() => vi.fn());
const mockGetCoderClientForUser = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@/lib/coder/user-client", () => ({
  getCoderClientForUser: mockGetCoderClientForUser,
}));

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: mockExecInWorkspace,
}));

import { uploadTerminalPasteAssets } from "@/lib/workspace/paste-assets";

function mockSpawnSuccess() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  };
  child.kill = vi.fn();
  child.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  child.stderr.setEncoding = vi.fn();
  child.stdin = new EventEmitter() as typeof child.stdin;
  child.stdin.end = vi.fn(() => {
    queueMicrotask(() => child.emit("close", 0));
  });
  mockSpawn.mockReturnValue(child);
  return child;
}

describe("uploadTerminalPasteAssets", () => {
  const upload = () =>
    uploadTerminalPasteAssets({
      userId: "user-1",
      workspaceId: "workspace-1",
      files: [{ name: "test.txt", type: "text/plain", bytes: new Uint8Array([1]) }],
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecInWorkspace.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockGetCoderClientForUser.mockResolvedValue({
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-token",
      getWorkspaceAgentName: vi.fn().mockResolvedValue("workspace.agent"),
    });
  });

  it("streams base64 file bytes through stdin instead of command argv", async () => {
    const child = mockSpawnSuccess();
    const bytes = new TextEncoder().encode("file-bytes");

    const paths = await uploadTerminalPasteAssets({
      userId: "user-1",
      workspaceId: "workspace-1",
      files: [{ name: "../unsafe path.txt", type: "text/plain", bytes }],
    });

    expect(paths[0]).toMatch(/^\/tmp\/hive-terminal-paste\/.+-unsafe-path\.txt$/);
    expect(mockExecInWorkspace).toHaveBeenCalledWith(
      "workspace.agent",
      "umask 077 && mkdir -p '/tmp/hive-terminal-paste'",
      expect.objectContaining({
        coderUrl: "https://coder.example.com",
        sessionToken: "coder-token",
      }),
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      "ssh",
      [
        "-o",
        "LogLevel=ERROR",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ProxyCommand=coder ssh --stdio %h",
        "workspace.agent",
        expect.stringMatching(
          /^bash -lc 'base64 -d > '\\''\/tmp\/hive-terminal-paste\/.+-unsafe-path\.txt'\\'''$/,
        ),
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          CODER_URL: "https://coder.example.com",
          CODER_SESSION_TOKEN: "coder-token",
        }),
        stdio: ["pipe", "ignore", "pipe"],
      }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from(bytes).toString("base64"));
    expect(JSON.stringify(mockSpawn.mock.calls)).not.toContain(
      Buffer.from(bytes).toString("base64"),
    );
  });

  it("rejects an actual writable EPIPE without crashing the process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = mockSpawnSuccess();
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
      },
    });
    mockSpawn.mockReturnValue({
      stdin,
      stderr: child.stderr,
      on: child.on.bind(child),
      kill: child.kill,
    });

    await expect(upload()).rejects.toThrow("Failed to store pasted file in workspace");

    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => child.emit("close", 0)).not.toThrow();
  });

  it.each([
    "stdin",
    "stderr",
  ] as const)("handles %s errors before a successful close", async (stream) => {
    vi.useFakeTimers();
    const child = mockSpawnSuccess();
    child.stdin.end.mockImplementation(() => {
      child[stream].emit("error", new Error("stream failed"));
      child.emit("close", 0);
    });

    await expect(upload()).rejects.toThrow("Failed to store pasted file in workspace");

    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles late stream and process errors after a failed close", async () => {
    vi.useFakeTimers();
    const child = mockSpawnSuccess();
    child.stdin.end.mockImplementation(() => child.emit("close", 1));

    await expect(upload()).rejects.toThrow("Failed to store pasted file in workspace");

    expect(() => {
      child.stdin.emit("error", new Error("late EPIPE"));
      child.stderr.emit("error", new Error("late read failure"));
      child.emit("error", new Error("late process failure"));
    }).not.toThrow();
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects process startup errors and clears the timeout", async () => {
    vi.useFakeTimers();
    const child = mockSpawnSuccess();
    child.stdin.end.mockImplementation(() => child.emit("error", new Error("spawn failed")));

    await expect(upload()).rejects.toThrow("Failed to store pasted file in workspace");

    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills a stalled SSH transfer and safely handles subsequent errors", async () => {
    vi.useFakeTimers();
    const child = mockSpawnSuccess();
    child.stdin.end.mockImplementation(() => undefined);
    const result = expect(upload()).rejects.toThrow("Failed to store pasted file in workspace");

    await vi.advanceTimersByTimeAsync(120_000);
    await result;

    expect(child.kill).toHaveBeenCalledOnce();
    expect(() => {
      child.stdin.emit("error", new Error("EPIPE after timeout"));
      child.emit("close", 0);
    }).not.toThrow();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
