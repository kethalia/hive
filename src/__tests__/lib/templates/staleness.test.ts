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

// ── Helpers ──────────────────────────────────────────────────────

/** Create a tar buffer from a map of { path: content } entries. */
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
    // Point process.cwd at the temp dir so hashLocalTemplate finds templates/<name>/
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
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
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

    // Add a .terraform directory — hash should not change
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
    // Create two tars with same files in different insertion order
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
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "staleness-cmp-"));
    process.cwd = () => tempDir;

    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("CODER_URL", "https://coder.test");
    vi.stubEnv("CODER_SESSION_TOKEN", "test-token");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.cwd = origCwd;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Mock fetch to return JSON for a given URL pattern. */
  function mockCoderApi(responses: Record<string, unknown>) {
    fetchSpy.mockImplementation(async (url: string) => {
      for (const [pattern, body] of Object.entries(responses)) {
        if (url.includes(pattern)) {
          if (body instanceof Buffer) {
            return new Response(body, {
              status: 200,
              headers: { "Content-Type": "application/x-tar" },
            });
          }
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      return new Response("not found", { status: 404 });
    });
  }

  it("returns stale=true when local and remote hashes differ", async () => {
    // Set up local template with different content than remote
    await mkdir(join(tempDir, "templates", "hive"), { recursive: true });
    await writeFile(join(tempDir, "templates", "hive", "main.tf"), "local content v2");

    const remoteTar = await createTarBuffer({ "main.tf": "remote content v1" });

    mockCoderApi({
      "/api/v2/organizations/default/templates": [
        { id: "t1", name: "hive", active_version_id: "ver-1", updated_at: "2026-04-01T00:00:00Z" },
      ],
      "/api/v2/templateversions/ver-1": {
        id: "ver-1",
        name: "v1",
        message: "initial",
        job: { file_id: "file-1" },
        created_at: "2026-04-01T00:00:00Z",
      },
      "/api/v2/files/file-1": remoteTar,
    });

    const results = await compareTemplates(["hive"]);

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("hive");
    expect(results[0].stale).toBe(true);
    expect(results[0].localHash).toMatch(/^[a-f0-9]{64}$/);
    expect(results[0].remoteHash).toMatch(/^[a-f0-9]{64}$/);
    expect(results[0].localHash).not.toBe(results[0].remoteHash);
  });

  it("returns stale=false when local and remote hashes match", async () => {
    // Same content locally and in the tar
    await mkdir(join(tempDir, "templates", "hive"), { recursive: true });
    await writeFile(join(tempDir, "templates", "hive", "main.tf"), "same content");

    const remoteTar = await createTarBuffer({ "main.tf": "same content" });

    mockCoderApi({
      "/api/v2/organizations/default/templates": [
        { id: "t1", name: "hive", active_version_id: "ver-1", updated_at: "2026-04-01T00:00:00Z" },
      ],
      "/api/v2/templateversions/ver-1": {
        id: "ver-1",
        name: "v1",
        message: "initial",
        job: { file_id: "file-1" },
        created_at: "2026-04-01T00:00:00Z",
      },
      "/api/v2/files/file-1": remoteTar,
    });

    const results = await compareTemplates(["hive"]);

    expect(results).toHaveLength(1);
    expect(results[0].stale).toBe(false);
    expect(results[0].localHash).toBe(results[0].remoteHash);
  });

  it("returns stale=true when template not found in remote", async () => {
    await mkdir(join(tempDir, "templates", "new-tpl"), { recursive: true });
    await writeFile(join(tempDir, "templates", "new-tpl", "main.tf"), "new");

    mockCoderApi({
      "/api/v2/organizations/default/templates": [], // no templates
    });

    const results = await compareTemplates(["new-tpl"]);

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

    mockCoderApi({
      "/api/v2/organizations/default/templates": [
        { id: "t1", name: "hive", active_version_id: "ver-1", updated_at: "2026-04-01T00:00:00Z" },
        { id: "t2", name: "ai-dev", active_version_id: "ver-2", updated_at: "2026-04-02T00:00:00Z" },
      ],
      "/api/v2/templateversions/ver-1": {
        id: "ver-1", name: "v1", message: "", job: { file_id: "file-1" }, created_at: "2026-04-01T00:00:00Z",
      },
      "/api/v2/templateversions/ver-2": {
        id: "ver-2", name: "v2", message: "", job: { file_id: "file-2" }, created_at: "2026-04-02T00:00:00Z",
      },
      "/api/v2/files/file-1": hiveTar,
      "/api/v2/files/file-2": aiDevTar,
    });

    const results = await compareTemplates(["hive", "ai-dev"]);

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("hive");
    expect(results[0].stale).toBe(false); // same content
    expect(results[1].name).toBe("ai-dev");
    expect(results[1].stale).toBe(true); // different content
  });

  it("throws when CODER_URL is not set", async () => {
    vi.stubEnv("CODER_URL", "");

    await expect(compareTemplates(["hive"])).rejects.toThrow(
      /CODER_URL and CODER_SESSION_TOKEN must be set/
    );
  });

  it("returns stale=false for all templates when Coder is unreachable", async () => {
    await mkdir(join(tempDir, "templates", "hive"), { recursive: true });
    await writeFile(join(tempDir, "templates", "hive", "main.tf"), "content");

    fetchSpy.mockRejectedValue(new Error("network error"));

    const results = await compareTemplates(["hive"]);

    expect(results).toHaveLength(1);
    expect(results[0].stale).toBe(false);
    expect(results[0].remoteHash).toBeNull();
  });
});
