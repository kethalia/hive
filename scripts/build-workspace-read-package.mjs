// The read service has an independent package/lifecycle from the managed Codex host.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

const names = ["hive-workspace-read.mjs", "hive-workspace-read.py"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function workspaceReadPackage(root) {
  const members = new Map();
  for (const name of names) {
    const source = await readFile(join(root, "templates/ai-dev-k8s/scripts", name));
    if (!source.length || source.length > 65536)
      throw new Error("Read service source exceeds bounds");
    members.set(name, source);
  }
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        files: Object.fromEntries([...members].map(([name, source]) => [name, hash(source)])),
      },
      null,
      2,
    )}\n`,
  );
  members.set("manifest.json", manifest);
  const pack = tar.pack(),
    chunks = [];
  const collect = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, source] of [...members].sort(([a], [b]) => a.localeCompare(b)))
    pack.entry(
      {
        name,
        type: "file",
        mode: name.endsWith(".json") ? 0o400 : 0o500,
        uid: 0,
        gid: 0,
        mtime: new Date(0),
      },
      source,
    );
  pack.finalize();
  await collect;
  const archive = Buffer.concat(chunks),
    compressed = gzipSync(archive, { level: 9 });
  if (archive.length > 131072 || compressed.length > 65536)
    throw new Error("Read service package exceeds installer bounds");
  return { archive, compressed, archiveSha256: hash(archive), manifestSha256: hash(manifest) };
}

export async function workspaceReadInstaller(root) {
  const source = await readFile(
    join(root, "templates/ai-dev-k8s/scripts/install-workspace-read.py"),
  );
  const compressed = gzipSync(source, { level: 9 });
  if (!source.length || source.length > 65536 || compressed.length > 24576)
    throw new Error("Read installer exceeds bootstrap bounds");
  return { compressed, sha256: hash(source) };
}

export async function syncWorkspaceReadPackage(root, check = false) {
  const artifact = await workspaceReadPackage(root);
  const installer = await workspaceReadInstaller(root);
  const output = new Map([
    ["workspace-read.tar.gz", artifact.compressed],
    ["workspace-read-installer.py.gz", installer.compressed],
    ["workspace-read-installer.sha256", Buffer.from(`${installer.sha256}\n`)],
    ["workspace-read.tar.sha256", Buffer.from(`${artifact.archiveSha256}\n`)],
    ["workspace-read.manifest.sha256", Buffer.from(`${artifact.manifestSha256}\n`)],
  ]);
  const directory = join(root, "templates/ai-dev-k8s/assets");
  if (!check) await mkdir(directory, { recursive: true });
  for (const [name, bytes] of output) {
    const path = join(directory, name);
    if (check) {
      if (!(await readFile(path)).equals(bytes))
        throw new Error("Read service package is stale; run pnpm templates:sync");
    } else await writeFile(path, bytes);
  }
  return artifact;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await syncWorkspaceReadPackage(process.cwd(), process.argv.includes("--check"));
