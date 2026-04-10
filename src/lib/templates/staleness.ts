import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import extract from "tar-stream";
import { CoderClient } from "@/lib/coder/client";

/** Templates known to this orchestrator. */
export const KNOWN_TEMPLATES = [
  "hive-worker",
  "hive-verifier",
  "hive-council",
  "ai-dev",
] as const;

export type KnownTemplate = (typeof KNOWN_TEMPLATES)[number];

/** Per-template staleness result. */
export interface TemplateStatus {
  name: string;
  stale: boolean;
  lastPushed: string | null;
  activeVersionId: string | null;
  localHash: string;
  remoteHash: string | null;
}

// ── Hashing helpers ───────────────────────────────────────────────

/**
 * Directories excluded from local hashing — mirrors what `coder templates push`
 * excludes when building the upload tar (provider cache, module downloads, etc.)
 */
const EXCLUDED_DIRS = new Set([".terraform"]);

/**
 * Recursively collect all file paths under `dir`, returning them
 * sorted deterministically relative to `dir`.
 * Skips directories that `coder templates push` doesn't upload.
 */
async function collectFiles(dir: string, base: string = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await collectFiles(full, base);
      paths.push(...sub);
    } else {
      paths.push(full.slice(base.length + 1)); // relative path
    }
  }

  return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Hash all files under `templates/<name>/` using sha256.
 * Sorted paths + contents are fed into the hash deterministically.
 */
export async function hashLocalTemplate(name: string): Promise<string> {
  const templateDir = join(process.cwd(), "templates", name);
  const hash = createHash("sha256");

  let files: string[];
  try {
    files = await collectFiles(templateDir);
  } catch (err) {
    throw new Error(
      `[staleness] Cannot read template directory "templates/${name}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  for (const relPath of files) {
    const content = await readFile(join(templateDir, relPath));
    hash.update(relPath);
    hash.update(content);
  }

  return hash.digest("hex");
}

/**
 * Hash all entries in a tar archive using sha256.
 * Entries are sorted by path before hashing for determinism.
 */
export async function hashRemoteTar(tarBuffer: Buffer): Promise<string> {
  const entries: { path: string; content: Buffer }[] = [];

  await new Promise<void>((resolve, reject) => {
    const extractor = extract.extract();

    extractor.on("entry", (header, stream, next) => {
      // Only hash regular files — skip directories, symlinks, etc.
      if (header.type !== "file") {
        stream.resume();
        next();
        return;
      }

      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        entries.push({
          path: header.name,
          content: Buffer.concat(chunks),
        });
        next();
      });
      stream.on("error", reject);
    });

    extractor.on("finish", resolve);
    extractor.on("error", reject);

    extractor.end(tarBuffer);
  });

  // Sort deterministically before hashing
  // Use byte-order sort (same as Python's default str sort) for determinism
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash("sha256");
  for (const { path, content } of entries) {
    hash.update(path);
    hash.update(content);
  }

  return hash.digest("hex");
}

// ── Comparison ────────────────────────────────────────────────────

/**
 * Compare local template directories against the currently active
 * remote versions in Coder.
 *
 * For each template name:
 *   1. Find matching template via listTemplates
 *   2. Fetch active version metadata via getTemplateVersion
 *   3. Download the tar archive via fetchTemplateFiles
 *   4. Compute both hashes and compare
 */
export async function compareTemplates(names: string[]): Promise<TemplateStatus[]> {
  const coderUrl = process.env.CODER_URL;
  const coderToken = process.env.CODER_SESSION_TOKEN;

  if (!coderUrl || !coderToken) {
    throw new Error(
      "[staleness] CODER_URL and CODER_SESSION_TOKEN must be set"
    );
  }

  const client = new CoderClient({
    baseUrl: coderUrl,
    sessionToken: coderToken,
  });

  // Fetch remote template list once
  let remoteTemplates: Awaited<ReturnType<typeof client.listTemplates>>;
  try {
    remoteTemplates = await client.listTemplates();
  } catch (err) {
    console.error(`[staleness] Failed to list remote templates: ${err instanceof Error ? err.message : String(err)}`);
    // Coder unreachable — return unknown state for all templates rather than
    // treating them as stale, which could prompt accidental pushes during outages.
    return names.map((name) => ({
      name,
      stale: false,
      lastPushed: null,
      activeVersionId: null,
      localHash: "",
      remoteHash: null,
    }));
  }

  const results: TemplateStatus[] = [];

  for (const name of names) {
    let localHash = "";
    let remoteHash: string | null = null;
    let activeVersionId: string | null = null;
    let lastPushed: string | null = null;

    // Compute local hash
    try {
      localHash = await hashLocalTemplate(name);
    } catch (err) {
      console.error(`[staleness] ${name}: local hash failed: ${err instanceof Error ? err.message : String(err)}`);
      results.push({ name, stale: false, lastPushed: null, activeVersionId: null, localHash: "", remoteHash: null });
      continue;
    }

    // Find matching remote template
    const remote = remoteTemplates.find((t) => t.name === name);
    if (!remote) {
      // Template not found in Coder — treat as stale (needs push)
      results.push({ name, stale: true, lastPushed: null, activeVersionId: null, localHash, remoteHash: null });
      continue;
    }

    activeVersionId = remote.activeVersionId;
    lastPushed = remote.updatedAt;

    // Fetch version and download tar
    try {
      const version = await client.getTemplateVersion(remote.activeVersionId);
      const tarBuffer = await client.fetchTemplateFiles(version.fileId);
      remoteHash = await hashRemoteTar(tarBuffer);
    } catch (err) {
      console.error(`[staleness] ${name}: remote hash failed: ${err instanceof Error ? err.message : String(err)}`);
      // Can't compare — leave remoteHash null, treat as unknown (not stale)
      results.push({ name, stale: false, lastPushed, activeVersionId, localHash, remoteHash: null });
      continue;
    }

    results.push({
      name,
      stale: localHash !== remoteHash,
      lastPushed,
      activeVersionId,
      localHash,
      remoteHash,
    });
  }

  return results;
}
