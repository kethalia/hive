import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter, Readable, Writable } from "stream";

// ── Mocks ────────────────────────────────────────────────────────

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    status: "ready",
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}));

vi.mock("@/lib/queue/connection", () => ({
  getRedisConnection: vi.fn(() => ({
    status: "ready",
    disconnect: vi.fn(),
    quit: vi.fn(),
  })),
}));

const MOCK_BASE_URL = "https://coder.example.com";
const MOCK_SESSION_TOKEN = "decrypted-token-abc";

vi.mock("@/lib/coder/user-client", () => ({
  getCoderClientForUser: vi.fn().mockResolvedValue({
    getBaseUrl: () => MOCK_BASE_URL,
    getSessionToken: () => MOCK_SESSION_TOKEN,
  }),
  UserClientException: class UserClientException extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "UserClientException";
    }
  },
  UserClientError: {
    NO_TOKEN: "NO_TOKEN",
    DECRYPT_FAILED: "DECRYPT_FAILED",
    USER_NOT_FOUND: "USER_NOT_FOUND",
  },
}));

let logChunks: string[] = [];
let mockWriteStream: Writable;

function createMockWriteStream() {
  logChunks = [];
  mockWriteStream = new Writable({
    write(chunk, _encoding, callback) {
      logChunks.push(chunk.toString());
      callback();
    },
  });
  return mockWriteStream;
}

vi.mock("fs", () => ({
  createWriteStream: vi.fn(() => createMockWriteStream()),
}));

vi.mock("fs/promises", () => ({
  readdir: vi.fn().mockRejectedValue(new Error("not readable")),
}));

let spawnedChild: EventEmitter & { stdout: Readable; stderr: Readable };
function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  return child;
}

const mockSpawn = vi.fn(() => {
  spawnedChild = createMockChild();
  return spawnedChild;
});

const mockExecFile = vi.fn((...args: unknown[]) => {
  const cb = args[args.length - 1] as (
    err: Error | null,
    result: { stdout: string; stderr: string },
  ) => void;
  const cmd = args[0] as string;
  const cmdArgs = args[1] as string[];

  if (cmd === "which" && cmdArgs[0] === "coder") {
    cb(null, { stdout: "/usr/bin/coder\n", stderr: "" });
  } else {
    cb(new Error("not found"), { stdout: "", stderr: "" });
  }
});

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

let capturedProcessor: ((job: {
  data: { templateName: string; jobId: string; userId: string };
}) => Promise<void>) | null = null;

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({ id: "job-1" }),
    close: vi.fn(),
  })),
  Worker: vi.fn().mockImplementation(
    (_name: string, processor: typeof capturedProcessor) => {
      capturedProcessor = processor;
      return { on: vi.fn(), close: vi.fn() };
    },
  ),
}));

// ── Import under test (after mocks) ─────────────────────────────

import {
  getTemplatePushQueue,
  createTemplatePushWorker,
  pushLogPath,
} from "@/lib/templates/push-queue";
import { createWriteStream } from "fs";

// ── Tests ────────────────────────────────────────────────────────

describe("push-queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logChunks = [];
    capturedProcessor = null;
  });

  describe("pushLogPath", () => {
    it("returns /tmp/template-push-<jobId>.log", () => {
      expect(pushLogPath("abc-123")).toBe("/tmp/template-push-abc-123.log");
    });
  });

  describe("getTemplatePushQueue", () => {
    it("returns a Queue instance", () => {
      const q = getTemplatePushQueue();
      expect(q).toBeDefined();
      expect(q.add).toBeDefined();
    });
  });

  describe("createTemplatePushWorker", () => {
    it("creates a worker and captures processor", () => {
      createTemplatePushWorker();
      expect(capturedProcessor).toBeInstanceOf(Function);
    });
  });

  describe("processor", () => {
    beforeEach(() => {
      createTemplatePushWorker();
    });

    it("resolves per-user credentials and spawns coder with them", async () => {
      const { getCoderClientForUser } = await import("@/lib/coder/user-client");

      const jobPromise = capturedProcessor!({
        data: { templateName: "hive", jobId: "job-1", userId: "user-abc" },
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), {
        timeout: 5000,
      });

      expect(getCoderClientForUser).toHaveBeenCalledWith("user-abc");

      const [bin, args, opts] = mockSpawn.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(bin).toBe("/usr/bin/coder");
      expect(args).toEqual([
        "templates",
        "push",
        "hive",
        "--directory",
        "templates/hive",
        "--yes",
      ]);

      expect(opts.env.CODER_URL).toBe(MOCK_BASE_URL);
      expect(opts.env.CODER_SESSION_TOKEN).toBe(MOCK_SESSION_TOKEN);

      spawnedChild.emit("close", 0);
      await jobPromise;
    });

    it("tees stdout and stderr to log file", async () => {
      const jobPromise = capturedProcessor!({
        data: { templateName: "ai-dev", jobId: "job-2", userId: "user-abc" },
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), {
        timeout: 5000,
      });

      expect(createWriteStream).toHaveBeenCalledWith(
        "/tmp/template-push-job-2.log",
        { flags: "a" },
      );

      spawnedChild.emit("close", 0);
      await jobPromise;
    });

    it("writes [exit:0] sentinel on success", async () => {
      const jobPromise = capturedProcessor!({
        data: { templateName: "hive", jobId: "job-3", userId: "user-abc" },
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), {
        timeout: 5000,
      });
      spawnedChild.emit("close", 0);
      await jobPromise;

      expect(logChunks.join("")).toContain("[exit:0]");
    });

    it("writes [exit:1] sentinel and rejects on non-zero exit", async () => {
      const jobPromise = capturedProcessor!({
        data: { templateName: "hive", jobId: "job-4", userId: "user-abc" },
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), {
        timeout: 5000,
      });
      spawnedChild.emit("close", 1);

      await expect(jobPromise).rejects.toThrow(
        "coder templates push exited with code 1",
      );

      expect(logChunks.join("")).toContain("[exit:1]");
    });

    it("rejects on spawn error and writes error to log", async () => {
      const jobPromise = capturedProcessor!({
        data: { templateName: "hive", jobId: "job-5", userId: "user-abc" },
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), {
        timeout: 5000,
      });

      spawnedChild.emit("error", new Error("ENOENT"));

      await expect(jobPromise).rejects.toThrow("ENOENT");

      const allLog = logChunks.join("");
      expect(allLog).toContain("[exit:1]");
      expect(allLog).toContain("ENOENT");
    });

    it("fails with clear error when userId has no token", async () => {
      const { getCoderClientForUser } = await import("@/lib/coder/user-client");
      const { UserClientException, UserClientError } = await import("@/lib/coder/user-client");
      vi.mocked(getCoderClientForUser).mockRejectedValueOnce(
        new UserClientException(UserClientError.NO_TOKEN, "No Coder API token stored for user bad-user")
      );

      await expect(
        capturedProcessor!({
          data: { templateName: "hive", jobId: "job-6", userId: "bad-user" },
        })
      ).rejects.toThrow("No Coder API token stored for user bad-user");
    });
  });
});
