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

// Track what was written to the log file via a real Writable stream
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

// Mock readdir for findCoderBinary /tmp scan
vi.mock("fs/promises", () => ({
  readdir: vi.fn().mockRejectedValue(new Error("not readable")),
}));

// Mock child_process
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

// execFile mock that works with promisify — callback is always the last argument
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

// Mock BullMQ — capture processor
let capturedProcessor: ((job: {
  data: { templateName: string; jobId: string };
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
    process.env.CODER_URL = "https://coder.example.com";
    process.env.CODER_SESSION_TOKEN = "test-token-abc";
  });

  afterEach(() => {
    delete process.env.CODER_URL;
    delete process.env.CODER_SESSION_TOKEN;
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

    it("spawns coder with correct args and env", async () => {
      const jobPromise = capturedProcessor!({
        data: { templateName: "hive", jobId: "job-1" },
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), {
        timeout: 5000,
      });

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

      // Verify CODER_URL and CODER_SESSION_TOKEN injected into child env
      expect(opts.env.CODER_URL).toBe("https://coder.example.com");
      expect(opts.env.CODER_SESSION_TOKEN).toBe("test-token-abc");

      // Simulate successful exit
      spawnedChild.emit("close", 0);
      await jobPromise;
    });

    it("tees stdout and stderr to log file", async () => {
      const jobPromise = capturedProcessor!({
        data: { templateName: "ai-dev", jobId: "job-2" },
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), {
        timeout: 5000,
      });

      // Verify createWriteStream called with correct path in append mode
      expect(createWriteStream).toHaveBeenCalledWith(
        "/tmp/template-push-job-2.log",
        { flags: "a" },
      );

      spawnedChild.emit("close", 0);
      await jobPromise;
    });

    it("writes [exit:0] sentinel on success", async () => {
      const jobPromise = capturedProcessor!({
        data: { templateName: "hive", jobId: "job-3" },
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
        data: { templateName: "hive", jobId: "job-4" },
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
        data: { templateName: "hive", jobId: "job-5" },
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled(), {
        timeout: 5000,
      });

      // Emit error — processor catches it, writes to log, and rejects
      spawnedChild.emit("error", new Error("ENOENT"));

      await expect(jobPromise).rejects.toThrow("ENOENT");

      const allLog = logChunks.join("");
      expect(allLog).toContain("[exit:1]");
      expect(allLog).toContain("ENOENT");
    });
  });
});
