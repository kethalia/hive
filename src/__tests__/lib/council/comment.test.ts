import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock child_process.execFile before importing the module under test
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

// Mock fs/promises for temp file operations
vi.mock("fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// The comment module uses promisify(execFile), so we mock execFile at the
// child_process module level and wrap it with a resolved/rejected promise shape.
import * as childProcess from "node:child_process";
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

  it("calls gh with --body-file and a temp file path", async () => {
    setupExecFileMock({ stdout: "https://github.com/owner/repo/pull/2#issuecomment-456\n" });
    await postPRComment("https://github.com/owner/repo/pull/2", "My comment body");

    expect(mockedExecFile).toHaveBeenCalledOnce();
    const [cmd, args] = mockedExecFile.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("gh");
    expect(args[0]).toBe("pr");
    expect(args[1]).toBe("comment");
    expect(args[2]).toBe("https://github.com/owner/repo/pull/2");
    expect(args[3]).toBe("--body-file");
    expect(args[4]).toMatch(/^\/tmp\/council-comment-\d+\.md$/);
  });

  it("writes body to temp file and cleans up after", async () => {
    const { writeFile, unlink } = await import("node:fs/promises");
    setupExecFileMock({ stdout: "https://github.com/owner/repo/pull/1#issuecomment-1\n" });

    await postPRComment("https://github.com/owner/repo/pull/1", "Comment body");

    expect(writeFile).toHaveBeenCalledOnce();
    const [path, content] = vi.mocked(writeFile).mock.calls[0] as [string, string, string];
    expect(path).toMatch(/^\/tmp\/council-comment-\d+\.md$/);
    expect(content).toBe("Comment body");
    expect(unlink).toHaveBeenCalledOnce();
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
