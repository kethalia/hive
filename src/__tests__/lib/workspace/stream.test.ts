import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process.spawn before importing the module under test
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { streamFromWorkspace } from "@/lib/workspace/stream";

const mockSpawn = vi.mocked(spawn);

/** Create a mock child process with stdout/stderr as EventEmitters */
function makeMockChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: null,
    pid: 12345,
    killed: false,
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
    }),
    ref: vi.fn(),
    unref: vi.fn(),
    connected: false,
    exitCode: null as number | null,
    signalCode: null as string | null,
    spawnargs: [] as string[],
    spawnfile: "",
    disconnect: vi.fn(),
    send: vi.fn(),
    stdio: [null, null, null, null, null] as any,
    [Symbol.dispose]: vi.fn(),
  });
  return child;
}

describe("streamFromWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("spawns the correct coder ssh command", () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as any);

    streamFromWorkspace("my-workspace", "echo hello");

    expect(mockSpawn).toHaveBeenCalledWith(
      "coder",
      ["ssh", "my-workspace", "--", "bash", "-l", "-c", "echo hello"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("emits complete lines from buffered chunks", async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { stdout } = streamFromWorkspace("ws", "cmd");
    const reader = stdout.getReader();

    // Emit two complete lines in one chunk
    child.stdout.emit("data", Buffer.from("line1\nline2\n"));

    const r1 = await reader.read();
    expect(r1.value).toBe("line1");

    const r2 = await reader.read();
    expect(r2.value).toBe("line2");

    // Close the child to end the stream
    child.emit("close", 0);

    const r3 = await reader.read();
    expect(r3.done).toBe(true);
  });

  it("handles partial lines across chunks correctly", async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { stdout } = streamFromWorkspace("ws", "cmd");
    const reader = stdout.getReader();

    // First chunk: partial line
    child.stdout.emit("data", Buffer.from("partial"));
    // Second chunk: completes the line and starts another
    child.stdout.emit("data", Buffer.from("-complete\nnext\n"));

    const r1 = await reader.read();
    expect(r1.value).toBe("partial-complete");

    const r2 = await reader.read();
    expect(r2.value).toBe("next");

    child.emit("close", 0);

    const r3 = await reader.read();
    expect(r3.done).toBe(true);
  });

  it("kills the process when AbortSignal fires", async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as any);

    const controller = new AbortController();
    streamFromWorkspace("ws", "cmd", controller.signal);

    expect(child.kill).not.toHaveBeenCalled();

    controller.abort();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("closes the stream when the child process exits", async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { stdout } = streamFromWorkspace("ws", "cmd");
    const reader = stdout.getReader();

    // Emit a line then close
    child.stdout.emit("data", Buffer.from("hello\n"));
    child.emit("close", 0);

    const r1 = await reader.read();
    expect(r1.value).toBe("hello");

    const r2 = await reader.read();
    expect(r2.done).toBe(true);
  });

  it("errors the stream when the child process fails to spawn", async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { stdout } = streamFromWorkspace("ws", "cmd");
    const reader = stdout.getReader();

    // Simulate spawn failure (e.g., 'coder' binary not found)
    const spawnError = new Error("spawn coder ENOENT");
    child.emit("error", spawnError);

    await expect(reader.read()).rejects.toThrow("spawn coder ENOENT");
  });

  it("logs stderr without breaking the stdout stream", async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { stdout } = streamFromWorkspace("ws", "cmd");
    const reader = stdout.getReader();

    // Emit stderr, then a stdout line, then close
    child.stderr.emit("data", Buffer.from("warning: something\n"));
    child.stdout.emit("data", Buffer.from("output\n"));
    child.emit("close", 0);

    const r1 = await reader.read();
    expect(r1.value).toBe("output");

    const r2 = await reader.read();
    expect(r2.done).toBe(true);

    // Stderr should have been logged (not thrown)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[stream] stderr:"));
  });

  it("kills the child via cancel() on the ReadableStream", async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { stdout } = streamFromWorkspace("ws", "cmd");

    // Cancel the stream (simulates client disconnect)
    await stdout.cancel();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("flushes remaining buffer on child exit", async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child as any);

    const { stdout } = streamFromWorkspace("ws", "cmd");
    const reader = stdout.getReader();

    // Emit partial line with no trailing newline
    child.stdout.emit("data", Buffer.from("no-newline"));
    child.emit("close", 0);

    const r1 = await reader.read();
    expect(r1.value).toBe("no-newline");

    const r2 = await reader.read();
    expect(r2.done).toBe(true);
  });
});
