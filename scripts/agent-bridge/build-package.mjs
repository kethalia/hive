import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

const defaultRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha = (data) => createHash("sha256").update(data).digest("hex");
export async function agentPackage(root = defaultRoot) {
  const files = new Map([
    ["agent-host.mjs", await readFile(resolve(root, "scripts/agent-bridge/host.mjs"))],
    ["agent-start.mjs", await readFile(resolve(root, "scripts/agent-bridge/start.mjs"))],
    [
      "agent-tools.py",
      await readFile(resolve(root, "templates/ai-dev-k8s/scripts/agent-tools.py")),
    ],
  ]);
  for (const data of files.values())
    if (!data.length || data.length > 65536) throw new Error("Agent source exceeds bounds");
  const manifest = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, files: Object.fromEntries([...files].map(([name, data]) => [name, sha(data)])) }, null, 2)}\n`,
  );
  files.set("manifest.json", manifest);
  const pack = tar.pack(),
    chunks = [];
  const collect = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b)))
    pack.entry(
      {
        name,
        type: "file",
        mode: name.endsWith(".json") ? 0o400 : 0o500,
        uid: 0,
        gid: 0,
        mtime: new Date(0),
      },
      data,
    );
  pack.finalize();
  await collect;
  const archive = Buffer.concat(chunks),
    compressed = gzipSync(archive, { level: 9 });
  if (archive.length > 262144 || compressed.length > 65536)
    throw new Error("Agent package exceeds bounds");
  return {
    archive,
    compressed,
    archiveSha256: sha(archive),
    manifestSha256: sha(manifest),
    helperSha256: sha(files.get("agent-tools.py")),
  };
}
export async function syncAgentPackage(root = defaultRoot, check = false) {
  const artifact = await agentPackage(root),
    installer = await readFile(
      resolve(root, "templates/ai-dev-k8s/scripts/install-agent-bridge.py"),
    );
  if (!installer.length || installer.length > 65536)
    throw new Error("Agent installer exceeds bounds");
  const output = new Map([
    ["agent-bridge.tar.gz", artifact.compressed],
    ["agent-bridge.tar.sha256", Buffer.from(`${artifact.archiveSha256}\n`)],
    ["agent-bridge.manifest.sha256", Buffer.from(`${artifact.manifestSha256}\n`)],
    ["agent-bridge.helper.sha256", Buffer.from(`${artifact.helperSha256}\n`)],
  ]);
  const directory = resolve(root, "templates/ai-dev-k8s/assets");
  if (!check) await mkdir(directory, { recursive: true });
  for (const [name, bytes] of output) {
    const path = resolve(directory, name);
    if (check) {
      if (!(await readFile(path)).equals(bytes)) throw new Error("Agent package is stale");
    } else await writeFile(path, bytes);
  }
  return artifact;
}
