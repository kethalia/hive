import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecFileException } from "child_process";
// Mock child_process before importing the module under test
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));
import { execInWorkspace } from "@/lib/workspace/exec";
import { execFile } from "child_process";

const mockExecFile = vi.mocked(execFile);

describe("execInWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns stdout and exitCode 0 on success", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, "hello world\n", "");
      return undefined as any;
    });

    const result = await execInWorkspace("my-workspace", "echo hello");

    expect(result).toEqual({
      stdout: "hello world\n",
      stderr: "",
      exitCode: 0,
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      "ssh",
      ["-T", "-o", "BatchMode=yes", "coder.my-workspace", "echo hello"],
      expect.objectContaining({ timeout: 60_000 }),
      expect.any(Function),
    );
  });

  it("returns non-zero exitCode with stderr on command failure", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("Command failed") as ExecFileException;
      err.code = 1 as unknown as string; // Node uses number for exit code
      (callback as Function)(err, "", "file not found\n");
      return undefined as any;
    });

    const result = await execInWorkspace("my-workspace", "cat missing.txt");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe("file not found\n");
  });

  it("handles timeout (killed process)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("Timed out") as ExecFileException & {
        killed: boolean;
      };
      err.killed = true;
      (callback as Function)(err, "", "");
      return undefined as any;
    });

    const result = await execInWorkspace("my-workspace", "sleep 999", {
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(124); // conventional timeout code
    expect(result.stderr).toContain("timed out");
  });

  it("handles timeout (ERR_CHILD_PROCESS_TIMEOUT code)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const err = new Error("Timed out") as ExecFileException;
      err.code = "ERR_CHILD_PROCESS_TIMEOUT";
      (callback as Function)(err, "", "");
      return undefined as any;
    });

    const result = await execInWorkspace("my-workspace", "sleep 999");

    expect(result.exitCode).toBe(124);
  });

  it("applies default timeout of 60s when no opts provided", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, "", "");
      return undefined as any;
    });

    await execInWorkspace("my-workspace", "ls");

    expect(mockExecFile).toHaveBeenCalledWith(
      "ssh",
      expect.any(Array),
      expect.objectContaining({ timeout: 60_000 }),
      expect.any(Function),
    );
  });

  it("uses login shell when loginShell option is true", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, "ok\n", "");
      return undefined as any;
    });

    await execInWorkspace("my-workspace", "node -v", { loginShell: true });

    expect(mockExecFile).toHaveBeenCalledWith(
      "ssh",
      ["-T", "-o", "BatchMode=yes", "coder.my-workspace", "bash -l -c 'node -v'"],
      expect.objectContaining({ timeout: 60_000 }),
      expect.any(Function),
    );
  });

  it("truncates long commands in log output", async () => {
    const logSpy = vi.spyOn(console, "log");
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, "", "");
      return undefined as any;
    });

    const longCommand = "x".repeat(200);
    await execInWorkspace("ws", longCommand);

    expect(mockExecFile).toHaveBeenCalledWith(
      "ssh",
      ["-T", "-o", "BatchMode=yes", "coder.ws", longCommand],
      expect.any(Object),
      expect.any(Function),
    );

    // But log output is truncated
    const logCall = logSpy.mock.calls[0]?.[0] as string;
    expect(logCall).toContain("…");
    expect(logCall.length).toBeLessThan(longCommand.length + 100);
  });
});
