import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tar from "tar-stream";

export const templateNames = [
  "ai-dev-k8s",
  "browser-testing",
  "game-dev",
  "electronics",
  "infrastructure",
];
const manifestPath = "src/lib/templates/artifact-manifest.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Build-owned input only. Private configuration, symlinks and excessive artifacts fail
 * before anything is published. No runtime filesystem or shell is required. */
export async function templateArtifact(directory) {
  const files = [];
  let total = 0;
  async function collect(prefix = "") {
    const entries = await readdir(join(directory, prefix), { withFileTypes: true });
    for (const entry of entries) {
      if ([".terraform", "__pycache__"].includes(entry.name) && entry.isDirectory()) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        throw new Error("Template contains a non-regular input");
      if (entry.isDirectory()) {
        await collect(path);
        continue;
      }
      if (/(^|\/)\.env(?:\.|$)|(^|\/)(?:credentials|id_rsa|id_ed25519)$/.test(path))
        throw new Error("Template contains a private configuration input");
      const stat = await lstat(join(directory, path));
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
        throw new Error("Template input exceeds bounds");
      const content = await readFile(join(directory, path));
      total += content.length;
      if (total > 16 * 1024 * 1024 || files.length >= 512)
        throw new Error("Template archive exceeds bounds");
      files.push({ path, content, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
  await collect();
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!files.some((file) => file.path === "main.tf"))
    throw new Error("Template main.tf is missing");
  const contentHash = createHash("sha256");
  const pack = tar.pack();
  const chunks = [];
  const collected = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const file of files) {
    contentHash.update(file.path).update(file.content);
    pack.entry(
      { name: file.path, type: "file", mode: file.mode, uid: 0, gid: 0, mtime: new Date(0) },
      file.content,
    );
  }
  pack.finalize();
  await collected;
  const archive = Buffer.concat(chunks);
  return {
    archive,
    metadata: {
      contentHash: contentHash.digest("hex"),
      archiveDigest: sha256(archive),
      archiveBytes: archive.length,
      fileCount: files.length,
    },
  };
}
export async function buildTemplateArtifacts(root, mode = "check") {
  if (!["check", "manifest", "assets"].includes(mode))
    throw new Error("Unknown template artifact operation");
  const artifacts = await Promise.all(
    templateNames.map(async (name) => [
      name,
      await templateArtifact(join(root, "templates", name)),
    ]),
  );
  const manifest = {
    schemaVersion: 1,
    templates: Object.fromEntries(artifacts.map(([name, value]) => [name, value.metadata])),
  };
  if (mode === "manifest") {
    await mkdir(dirname(join(root, manifestPath)), { recursive: true });
    await writeFile(join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    const existing = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
    if (JSON.stringify(existing) !== JSON.stringify(manifest))
      throw new Error(
        "Template artifact manifest is stale; regenerate and commit it before building",
      );
    if (mode === "assets") {
      const destination = join(root, "public/hive-template-artifacts");
      await mkdir(destination, { recursive: true });
      const retained = new Set(artifacts.map(([, value]) => `${value.metadata.archiveDigest}.tar`));
      for (const file of await readdir(destination, { withFileTypes: true })) {
        if (!file.isFile() || !/^[a-f0-9]{64}\.tar$/.test(file.name))
          throw new Error("Unrecognized file in build-owned template assets");
        if (!retained.has(file.name)) await rm(join(destination, file.name));
      }
      for (const [, { archive, metadata }] of artifacts)
        await writeFile(join(destination, `${metadata.archiveDigest}.tar`), archive);
    }
  }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildTemplateArtifacts(
    process.cwd(),
    process.argv.includes("--manifest")
      ? "manifest"
      : process.argv.includes("--assets")
        ? "assets"
        : "check",
  );
  console.log("Template artifacts verified.");
}
