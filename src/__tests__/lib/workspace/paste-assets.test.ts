import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCoderClientForUser = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@/lib/coder/user-client", () => ({
  getCoderClientForUser: mockGetCoderClientForUser,
}));

import { uploadTerminalPasteAssets } from "@/lib/workspace/paste-assets";

function mockSpawnSuccess() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  };
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  });
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
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCoderClientForUser.mockResolvedValue({
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-token",
      getWorkspaceAgentName: vi.fn().mockResolvedValue("workspace.agent"),
    });
  });

  it("streams raw file bytes through stdin instead of command argv", async () => {
    const child = mockSpawnSuccess();
    const bytes = new TextEncoder().encode("file-bytes");

    const paths = await uploadTerminalPasteAssets({
      userId: "user-1",
      workspaceId: "workspace-1",
      files: [{ name: "../unsafe path.txt", type: "text/plain", bytes }],
    });

    expect(paths[0]).toMatch(/^\/tmp\/hive-terminal-paste\/.+-unsafe-path\.txt$/);
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
        expect.stringMatching(/^bash -lc 'umask 077 && mkdir -p .*cat > .*unsafe-path\.txt.*$/),
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          CODER_URL: "https://coder.example.com",
          CODER_SESSION_TOKEN: "coder-token",
        }),
        stdio: ["pipe", "ignore", "pipe"],
      }),
    );
    expect(child.stdin.end).toHaveBeenCalledWith(bytes);
    expect(JSON.stringify(mockSpawn.mock.calls)).not.toContain("file-bytes");
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

describe("paste transfer bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCoderClientForUser.mockResolvedValue({
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "fixture-token",
      getWorkspaceAgentName: vi.fn().mockResolvedValue("workspace.agent"),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const file = () => new File(["raw bytes"], "file.txt", { type: "text/plain" });

  it("reads and transfers one file at a time, in input order", async () => {
    const first = mockSpawnSuccess();
    first.stdin.end.mockImplementation(() => undefined);
    const second = mockSpawnSuccess();
    second.stdin.end.mockImplementation(() => undefined);
    mockSpawn.mockReset().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const files = [file(), file()];
    const reads = files.map((file) => vi.spyOn(file, "arrayBuffer"));
    const result = uploadTerminalPasteAssets({
      userId: "user-1",
      workspaceId: "workspace-1",
      files,
    });
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
    expect(reads[0]).toHaveBeenCalledOnce();
    expect(reads[1]).not.toHaveBeenCalled();
    first.emit("close", 0);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
    expect(reads[1]).toHaveBeenCalledOnce();
    second.emit("close", 0);
    const paths = await result;
    expect(paths).toHaveLength(2);
    expect(mockSpawn.mock.calls[0][1].at(-1)).toContain(paths[0]);
    expect(mockSpawn.mock.calls[1][1].at(-1)).toContain(paths[1]);
  });

  it("enforces aggregate size for direct helper callers before credential lookup", async () => {
    const files = [10 * 1024 * 1024, 10 * 1024 * 1024, 1].map((size) => ({
      name: "x",
      type: "",
      bytes: new Uint8Array(size),
    }));
    await expect(
      uploadTerminalPasteAssets({ userId: "user-1", workspaceId: "workspace-1", files }),
    ).rejects.toThrow("20 MiB");
    expect(mockGetCoderClientForUser).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("rejects a pre-aborted transfer without credential lookup", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadTerminalPasteAssets({
        userId: "user-1",
        workspaceId: "workspace-1",
        files: [file()],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(mockGetCoderClientForUser).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("does not spawn SSH after cancellation during workspace lookup", async () => {
    const controller = new AbortController();
    const getWorkspaceAgentName = vi.fn(async (_workspaceId, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return "workspace.agent";
    });
    mockGetCoderClientForUser.mockResolvedValue({ getWorkspaceAgentName });
    await expect(
      uploadTerminalPasteAssets({
        userId: "user-1",
        workspaceId: "workspace-1",
        files: [file()],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(getWorkspaceAgentName).toHaveBeenCalledOnce();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("kills the SSH/Coder process group on abort, waits for close, and skips remaining files", async () => {
    const controller = new AbortController();
    const child = mockSpawnSuccess();
    child.stdin.end.mockImplementation(() => undefined);
    Object.assign(child, { pid: 1234567 });
    const killGroup = vi.spyOn(process, "kill").mockReturnValue(true);
    const files = [file(), file()];
    const laterRead = vi.spyOn(files[1], "arrayBuffer");
    const result = uploadTerminalPasteAssets({
      userId: "user-1",
      workspaceId: "workspace-1",
      files,
      signal: controller.signal,
    });
    let settled = false;
    const assertion = expect(
      result.finally(() => {
        settled = true;
      }),
    ).rejects.toThrow("Failed to store");
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledOnce());
    controller.abort();
    expect(killGroup).toHaveBeenCalledExactlyOnceWith(-1234567, "SIGKILL");
    expect(settled).toBe(false);
    child.emit("close", null);
    await assertion;
    expect(laterRead).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(() => child.stdin.emit("error", new Error("late EPIPE"))).not.toThrow();
  });

  it("stops the batch on a failed transfer without reading later files", async () => {
    const child = mockSpawnSuccess();
    child.stdin.end.mockImplementation(() => child.emit("close", 1));
    const files = [file(), file()];
    const laterRead = vi.spyOn(files[1], "arrayBuffer");
    await expect(
      uploadTerminalPasteAssets({ userId: "user-1", workspaceId: "workspace-1", files }),
    ).rejects.toThrow("Failed to store");
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(laterRead).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform === "win32")(
  "aborting a real transfer closes pipes held by the SSH proxy child",
  async () => {
    const { spawn: realSpawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const controller = new AbortController();
    let child: ReturnType<typeof realSpawn> | undefined;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    mockGetCoderClientForUser.mockResolvedValue({
      getBaseUrl: () => "https://coder.test",
      getSessionToken: () => "fixture-token",
      getWorkspaceAgentName: async () => "workspace.agent",
    });
    mockSpawn.mockImplementationOnce((_command, _args, options) => {
      child = realSpawn(
        process.execPath,
        [
          "-e",
          `
      const { spawn } = require("node:child_process");
      process.stdin.resume();
      const proxy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "inherit"] });
      proxy.once("spawn", () => process.stderr.write("ready"));
      setInterval(() => {}, 1000);
    `,
        ],
        options,
      );
      child.stderr!.once("data", ready);
      return child;
    });
    const result = uploadTerminalPasteAssets({
      userId: "user-1",
      workspaceId: "workspace-1",
      files: [{ name: "x", type: "", bytes: new Uint8Array([0, 255]) }],
      signal: controller.signal,
    });
    const assertion = expect(result).rejects.toThrow("Failed to store");
    try {
      await started;
      controller.abort();
      await assertion;
      expect(child!.signalCode).toBe("SIGKILL");
    } finally {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    }
  },
);

it.each([
  false,
  true,
])("runs the actual storage command and cleans incomplete data (truncated=%s)", async (truncated) => {
  const { spawn: realSpawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { mkdtemp, readFile, readdir, stat, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/hive-paste-command-");
  const bytes = new Uint8Array([0, 255, 1, 10, 13, 0, 128]);
  mockGetCoderClientForUser.mockResolvedValue({
    getBaseUrl: () => "https://coder.test",
    getSessionToken: () => "fixture-token",
    getWorkspaceAgentName: async () => "workspace.agent",
  });
  mockSpawn.mockImplementationOnce((_command, args, options) => {
    // Replace only the destination directory; execute the production quoting/trap/size check.
    const child = realSpawn(
      "bash",
      ["-c", args.at(-1).replaceAll("/tmp/hive-terminal-paste", directory)],
      options,
    );
    if (truncated) {
      const stdin = child.stdin!;
      const end = stdin.end.bind(stdin);
      stdin.end = ((bytes: Uint8Array) => end(bytes.subarray(0, 1))) as typeof stdin.end;
    }
    return child;
  });
  try {
    const result = uploadTerminalPasteAssets({
      userId: "user-1",
      workspaceId: "workspace-1",
      files: [{ name: "unsafe ' path.bin", type: "", bytes }],
    });
    if (truncated) {
      await expect(result).rejects.toThrow("Failed to store");
      expect(await readdir(directory)).toEqual([]);
    } else {
      const [path] = await result;
      const localPath = path.replace("/tmp/hive-terminal-paste", directory);
      expect(await readFile(localPath)).toEqual(Buffer.from(bytes));
      expect((await stat(localPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(directory)).toHaveLength(1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
