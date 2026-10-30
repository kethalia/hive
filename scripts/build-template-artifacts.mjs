import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { transform } from "esbuild";
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

/** Only omit a loose runtime source after verifying the installed copy, including the
 * exact build transform. Paths referenced by Terraform or bootstrap stay distributable. */
async function deduplicateHostSources(files) {
  const gzip = files.find((file) => file.path === "assets/codex-host.tar.gz");
  if (!gzip) return files;
  if (gzip.content.length > 160000) throw new Error("Host gzip exceeds metadata bounds");
  const archive = gunzipSync(gzip.content, { maxOutputLength: 2 * 1024 * 1024 });
  const expected = files.find((file) => file.path === "assets/codex-host.tar.sha256");
  if (!expected || expected.content.toString().trim() !== sha256(archive))
    throw new Error("Host archive digest mismatch");
  const contents = new Map();
  const extractor = tar.extract();
  await new Promise((resolve, reject) => {
    extractor.on("error", reject);
    extractor.on("finish", resolve);
    extractor.on("entry", (header, stream, next) => {
      if (
        header.type !== "file" ||
        contents.has(header.name) ||
        contents.size >= 64 ||
        header.size > 1024 * 1024 ||
        !/^(?:vendor\/ws\.mjs|codex-native-guardian|[a-z0-9-]+\.(?:mjs|py|json))$/.test(header.name)
      ) {
        extractor.destroy(new Error("Invalid host package entry"));
        stream.resume();
        return;
      }
      contents.set(header.name, null);
      const chunks = [];
      stream.on("error", reject);
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        contents.set(header.name, Buffer.concat(chunks));
        next();
      });
    });
    extractor.end(archive);
  });
  const manifest = JSON.parse(contents.get("package-manifest.json")?.toString() ?? "null");
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.nodeMajor !== 24 ||
    manifest.nativeVersion !== "0.165.0" ||
    manifest.wsVersion !== "8.21.3" ||
    !manifest.files ||
    Object.keys(manifest.files).length !== contents.size - 1
  )
    throw new Error("Invalid host package manifest");
  for (const [name, digest] of Object.entries(manifest.files)) {
    const value = contents.get(name);
    if (!value || sha256(value) !== digest) throw new Error("Host package file digest mismatch");
  }
  const candidates = new Set();
  for (const file of files) {
    const name = file.path.replace(/^scripts\//, "");
    if (file.path !== `scripts/${name}` || !/\.(mjs|py)$/.test(name) || !contents.has(name))
      continue;
    const source = name.endsWith(".mjs")
      ? Buffer.from(
          (
            await transform(
              file.content.toString().replaceAll('from "ws"', 'from "./vendor/ws.mjs"'),
              {
                loader: "js",
                format: "esm",
                target: "node24",
                minifyWhitespace: true,
                minifyIdentifiers: true,
                minifySyntax: false,
                keepNames: true,
              },
            )
          ).code,
        )
      : file.content;
    if (!source.equals(contents.get(name)))
      throw new Error(`Stale packaged runtime source: ${name}`);
    candidates.add(file.path);
  }
  // All Terraform input references must remain literal so this build can prove the
  // deployed file set. Installed package paths are a separate namespace: e.g. the
  // Python installer reads target/<module> only after verified archive extraction.
  for (const file of files.filter((file) => file.path.endsWith(".tf"))) {
    const text = file.content.toString();
    if (/\$\{path\.module\}\/scripts\/[^"\n]*\$\{|fileset\([^)]*scripts/.test(text))
      throw new Error("Dynamic template script reference requires explicit packaging review");
  }
  let changed;
  do {
    changed = false;
    for (const candidate of candidates) {
      const name = candidate.slice("scripts/".length);
      const referenced = files.some((file) => {
        if (candidates.has(file.path) || !/\.(?:tf|tftpl|sh|py|mjs)$/.test(file.path)) return false;
        const text = file.content.toString();
        return (
          text.includes(candidate) ||
          (/\.(?:tf|tftpl|sh|py)$/.test(file.path) && text.includes(name)) ||
          (file.path.startsWith("scripts/") &&
            /\.mjs$/.test(file.path) &&
            text.includes(`./${name}`))
        );
      });
      if (referenced) {
        candidates.delete(candidate);
        changed = true;
      }
    }
  } while (changed);
  return files.filter((file) => !candidates.has(file.path));
}

/** Build-owned input only. Private configuration, symlinks and excessive artifacts fail
 * before anything is published. No runtime filesystem or shell is required. */
export async function templateArtifact(directory) {
  let files = [];
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
  files = await deduplicateHostSources(files);
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
  // The configured Coder deployment rejects file uploads above one MiB.
  if (archive.length > 1024 * 1024) throw new Error("Template archive exceeds Coder upload bounds");
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
