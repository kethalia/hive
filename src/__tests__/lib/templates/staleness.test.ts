import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import * as tar from "tar-stream";
import {
  hashLocalTemplate,
  hashRemoteTar,
  compareTemplates,
} from "@/lib/templates/staleness";

// ── Mock getCoderClientForUser ──────────────────────────────────

const mockListTemplates = vi.fn();
const mockGetTemplateVersion = vi.fn();
const mockFetchTemplateFiles = vi.fn();

vi.mock("@/lib/coder/user-client", () => {
  class UserClientException extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
      this.name = "UserClientException";
    }
  }
  return {
    getCoderClientForUser: vi.fn().mockImplementation(async () => ({
      listTemplates: (...args: unknown[]) => mockListTemplates(...args),
      getTemplateVersion: (...args: unknown[]) => mockGetTemplateVersion(...args),
      fetchTemplateFiles: (...args: unknown[]) => mockFetchTemplateFiles(...args),
    })),
    UserClientException,
    UserClientError: {
      NO_TOKEN: "NO_TOKEN",
      DECRYPT_FAILED: "DECRYPT_FAILED",
      USER_NOT_FOUND: "USER_NOT_FOUND",
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────

function createTarBuffer(
  files: Record<string, string>
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(Buffer.concat(chunks)));
    pack.on("error", reject);

    for (const [name, content] of Object.entries(files)) {
      pack.entry({ name, type: "file" }, content);
    }
    pack.finalize();
  });
}

// ── hashLocalTemplate ────────────────────────────────────────────

describe("hashLocalTemplate", () => {
  let tempDir: string;
  const origCwd = process.cwd;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "staleness-test-"));
    process.cwd = () => tempDir;
  });

  afterEach(async () => {
    process.cwd = origCwd;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns stable hash across two calls with same files", async () => {
    await mkdir(join(tempDir, "templates", "test-tpl"), { recursive: true });
    await writeFile(join(tempDir, "templates", "test-tpl", "main.tf"), "resource {}");
    await writeFile(join(tempDir, "templates", "test-tpl", "README.md"), "# Hello");

    const hash1 = await hashLocalTemplate("test-tpl");
    const hash2 = await hashLocalTemplate("test-tpl");

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hash when file content changes", async () => {
    await mkdir(join(tempDir, "templates", "test-tpl"), { recursive: true });
    await writeFile(join(tempDir, "templates", "test-tpl", "main.tf"), "v1");

    const hash1 = await hashLocalTemplate("test-tpl");

    await writeFile(join(tempDir, "templates", "test-tpl", "main.tf"), "v2");

    const hash2 = await hashLocalTemplate("test-tpl");

    expect(hash1).not.toBe(hash2);
  });

  it("excludes .terraform directory from hash", async () => {
    const tplDir = join(tempDir, "templates", "test-tpl");
    await mkdir(tplDir, { recursive: true });
    await writeFile(join(tplDir, "main.tf"), "resource {}");

    const hashWithout = await hashLocalTemplate("test-tpl");

    await mkdir(join(tplDir, ".terraform"), { recursive: true });
    await writeFile(join(tplDir, ".terraform", "lock.json"), "{}");

    const hashWith = await hashLocalTemplate("test-tpl");

    expect(hashWithout).toBe(hashWith);
  });

  it("throws for missing template directory", async () => {
    await expect(hashLocalTemplate("nonexistent")).rejects.toThrow(
      /Cannot read template directory/
    );
  });
});

// ── hashRemoteTar ────────────────────────────────────────────────

describe("hashRemoteTar", () => {
  it("returns stable hash across two calls with same buffer", async () => {
    const buf = await createTarBuffer({
      "main.tf": "resource {}",
      "README.md": "# Hello",
    });

    const hash1 = await hashRemoteTar(buf);
    const hash2 = await hashRemoteTar(buf);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hash for different content", async () => {
    const buf1 = await createTarBuffer({ "main.tf": "v1" });
    const buf2 = await createTarBuffer({ "main.tf": "v2" });

    const hash1 = await hashRemoteTar(buf1);
    const hash2 = await hashRemoteTar(buf2);

    expect(hash1).not.toBe(hash2);
  });

  it("is order-independent (deterministic sort)", async () => {
    const buf1 = await createTarBuffer({
      "a.tf": "aaa",
      "b.tf": "bbb",
    });
    const buf2 = await createTarBuffer({
      "b.tf": "bbb",
      "a.tf": "aaa",
    });

    const hash1 = await hashRemoteTar(buf1);
    const hash2 = await hashRemoteTar(buf2);

    expect(hash1).toBe(hash2);
  });
});

// ── compareTemplates ─────────────────────────────────────────────

describe("compareTemplates", () => {
  let tempDir: string;
  const origCwd = process.cwd;

  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "staleness-cmp-"));
    process.cwd = () => tempDir;
    mockListTemplates.mockReset();
    mockGetTemplateVersion.mockReset();
    mockFetchTemplateFiles.mockReset();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.cwd = origCwd;
    consoleErrorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns stale=true when local and remote hashes differ", async () => {
    await mkdir(join(tempDir, "templates", "hive"), { recursive: true });
    await writeFile(join(tempDir, "templates", "hive", "main.tf"), "local content v2");

    const remoteTar = await createTarBuffer({ "main.tf": "remote content v1" });

    mockListTemplates.mockResolvedValue([
      { id: "t1", name: "hive", activeVersionId: "ver-1", updatedAt: "2026-04-01T00:00:00Z" },
    ]);
    mockGetTemplateVersion.mockResolvedValue({
      id: "ver-1", name: "v1", message: "initial", fileId: "file-1", createdAt: "2026-04-01T00:00:00Z",
    });
    mockFetchTemplateFiles.mockResolvedValue(remoteTar);

    const results = await compareTemplates(["hive"], "user-123");

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("hive");
    expect(results[0].stale).toBe(true);
    expect(results[0].localHash).toMatch(/^[a-f0-9]{64}$/);
    expect(results[0].remoteHash).toMatch(/^[a-f0-9]{64}$/);
    expect(results[0].localHash).not.toBe(results[0].remoteHash);
  });

  it("returns stale=false when local and remote hashes match", async () => {
    await mkdir(join(tempDir, "templates", "hive"), { recursive: true });
    await writeFile(join(tempDir, "templates", "hive", "main.tf"), "same content");

    const remoteTar = await createTarBuffer({ "main.tf": "same content" });

    mockListTemplates.mockResolvedValue([
      { id: "t1", name: "hive", activeVersionId: "ver-1", updatedAt: "2026-04-01T00:00:00Z" },
    ]);
    mockGetTemplateVersion.mockResolvedValue({
      id: "ver-1", name: "v1", message: "initial", fileId: "file-1", createdAt: "2026-04-01T00:00:00Z",
    });
    mockFetchTemplateFiles.mockResolvedValue(remoteTar);

    const results = await compareTemplates(["hive"], "user-123");

    expect(results).toHaveLength(1);
    expect(results[0].stale).toBe(false);
    expect(results[0].localHash).toBe(results[0].remoteHash);
  });

  it("returns stale=true when template not found in remote", async () => {
    await mkdir(join(tempDir, "templates", "new-tpl"), { recursive: true });
    await writeFile(join(tempDir, "templates", "new-tpl", "main.tf"), "new");

    mockListTemplates.mockResolvedValue([]);

    const results = await compareTemplates(["new-tpl"], "user-123");

    expect(results).toHaveLength(1);
    expect(results[0].stale).toBe(true);
    expect(results[0].remoteHash).toBeNull();
    expect(results[0].activeVersionId).toBeNull();
  });

  it("handles multiple templates in one call", async () => {
    await mkdir(join(tempDir, "templates", "hive"), { recursive: true });
    await mkdir(join(tempDir, "templates", "ai-dev"), { recursive: true });
    await writeFile(join(tempDir, "templates", "hive", "main.tf"), "hive content");
    await writeFile(join(tempDir, "templates", "ai-dev", "main.tf"), "ai-dev content");

    const hiveTar = await createTarBuffer({ "main.tf": "hive content" });
    const aiDevTar = await createTarBuffer({ "main.tf": "different content" });

    mockListTemplates.mockResolvedValue([
      { id: "t1", name: "hive", activeVersionId: "ver-1", updatedAt: "2026-04-01T00:00:00Z" },
      { id: "t2", name: "ai-dev", activeVersionId: "ver-2", updatedAt: "2026-04-02T00:00:00Z" },
    ]);
    mockGetTemplateVersion.mockImplementation(async (versionId: string) => {
      if (versionId === "ver-1") return { id: "ver-1", name: "v1", message: "", fileId: "file-1", createdAt: "2026-04-01T00:00:00Z" };
      return { id: "ver-2", name: "v2", message: "", fileId: "file-2", createdAt: "2026-04-02T00:00:00Z" };
    });
    mockFetchTemplateFiles.mockImplementation(async (fileId: string) => {
      return fileId === "file-1" ? hiveTar : aiDevTar;
    });

    const results = await compareTemplates(["hive", "ai-dev"], "user-123");

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("hive");
    expect(results[0].stale).toBe(false);
    expect(results[1].name).toBe("ai-dev");
    expect(results[1].stale).toBe(true);
  });

  it("uses getCoderClientForUser with provided userId", async () => {
    const { getCoderClientForUser } = await import("@/lib/coder/user-client");
    await mkdir(join(tempDir, "templates", "hive"), { recursive: true });
    await writeFile(join(tempDir, "templates", "hive", "main.tf"), "content");
    mockListTemplates.mockResolvedValue([]);

    await compareTemplates(["hive"], "user-456");

    expect(getCoderClientForUser).toHaveBeenCalledWith("user-456");
  });

  it("throws USER_NOT_FOUND for invalid userId", async () => {
    const { getCoderClientForUser, UserClientException } = await import("@/lib/coder/user-client");
    vi.mocked(getCoderClientForUser).mockRejectedValueOnce(
      new (UserClientException as unknown as new (code: string, msg: string) => Error)("USER_NOT_FOUND", "User not-real not found")
    );

    await expect(compareTemplates(["hive"], "not-real")).rejects.toThrow("User not-real not found");
  });

  it("returns stale=false for all templates when Coder is unreachable", async () => {
    await mkdir(join(tempDir, "templates", "hive"), { recursive: true });
    await writeFile(join(tempDir, "templates", "hive", "main.tf"), "content");

    mockListTemplates.mockRejectedValue(new Error("network error"));

    const results = await compareTemplates(["hive"], "user-123");

    expect(results).toHaveLength(1);
    expect(results[0].stale).toBe(false);
    expect(results[0].remoteHash).toBeNull();
  });
});
