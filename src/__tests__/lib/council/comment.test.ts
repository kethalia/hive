import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock child_process.execFile before importing the module under test
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

// The comment module uses promisify(execFile), so we mock execFile at the
// child_process module level and wrap it with a resolved/rejected promise shape.
import * as childProcess from "child_process";
import { postPRComment } from "../../../lib/council/comment.js";

const mockedExecFile = vi.mocked(childProcess.execFile);

/**
 * util.promisify(execFile) calls execFile(cmd, args, opts, callback).
 * We simulate that by having the mock invoke the last argument (callback) with
 * the appropriate result.
 */
function setupExecFileMock(result: { stdout: string; stderr?: string } | Error): void {
  mockedExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      result?: { stdout: string; stderr: string },
    ) => void;
    if (result instanceof Error) {
      callback(result);
    } else {
      callback(null, { stdout: result.stdout, stderr: result.stderr ?? "" });
    }
    // promisify ignores the return value
    return undefined as unknown as ReturnType<typeof childProcess.execFile>;
  });
}

describe("postPRComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a non-null URL on successful gh execution", async () => {
    setupExecFileMock({ stdout: "https://github.com/owner/repo/pull/1#issuecomment-123\n" });
    const result = await postPRComment("https://github.com/owner/repo/pull/1", "Hello");
    expect(result).toBe("https://github.com/owner/repo/pull/1#issuecomment-123");
  });

  it("returns null (does not throw) when gh fails", async () => {
    setupExecFileMock(new Error("gh: command not found"));
    const result = await postPRComment("https://github.com/owner/repo/pull/1", "Hello");
    expect(result).toBeNull();
  });

  it("calls gh with the correct arguments", async () => {
    setupExecFileMock({ stdout: "https://github.com/owner/repo/pull/2#issuecomment-456\n" });
    await postPRComment("https://github.com/owner/repo/pull/2", "My comment body");

    expect(mockedExecFile).toHaveBeenCalledOnce();
    const [cmd, args] = mockedExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr",
      "comment",
      "https://github.com/owner/repo/pull/2",
      "--body",
      "My comment body",
    ]);
  });

  it("returns null when gh stdout is empty", async () => {
    setupExecFileMock({ stdout: "" });
    const result = await postPRComment("https://github.com/owner/repo/pull/3", "body");
    expect(result).toBeNull();
  });

  it("returns null when gh stdout is only whitespace", async () => {
    setupExecFileMock({ stdout: "   \n  " });
    const result = await postPRComment("https://github.com/owner/repo/pull/3", "body");
    expect(result).toBeNull();
  });
});
