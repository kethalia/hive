// Build an independent, deterministic candidate package from the pinned local ws distribution.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const defaultRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha = (data) => createHash("sha256").update(data).digest("hex");
export async function voicePackage(root = defaultRoot) {
  const ws = JSON.parse(await readFile(require.resolve("ws/package.json"), "utf8"));
  if (ws.version !== "8.21.3") throw new Error("Unsupported ws distribution");
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["scripts/voice/voice-host.mjs"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node24",
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: false,
    keepNames: true,
    banner: {
      js: 'import { createRequire as vendorCreateRequire } from "node:module"; const require = vendorCreateRequire(import.meta.url);',
    },
  });
  const source = result.outputFiles[0].contents;
  if (!source.length || source.length > 524288) throw new Error("Voice host package too large");
  const startup = await readFile(resolve(root, "scripts/voice/voice-host-start.mjs"));
  const manifest = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, files: { "voice-host.mjs": sha(source), "voice-host-start.mjs": sha(startup) } }, null, 2)}\n`,
  );
  const pack = tar.pack(),
    chunks = [];
  const collect = (async () => {
    for await (const chunk of pack) chunks.push(chunk);
  })();
  for (const [name, bytes] of [
    ["manifest.json", manifest],
    ["voice-host.mjs", source],
    ["voice-host-start.mjs", startup],
  ])
    pack.entry(
      {
        name,
        type: "file",
        mode: name.endsWith(".json") ? 0o400 : 0o500,
        uid: 0,
        gid: 0,
        mtime: new Date(0),
      },
      bytes,
    );
  pack.finalize();
  await collect;
  const archive = Buffer.concat(chunks),
    compressed = gzipSync(archive, { level: 9 });
  if (archive.length > 524288 || compressed.length > 131072)
    throw new Error("Voice archive too large");
  return { archive, compressed, archiveSha256: sha(archive), manifestSha256: sha(manifest) };
}

/** Sync only the canonical profile; the profile synchronizer copies it at freeze. */
export async function syncVoicePackage(root = defaultRoot, check = false) {
  const artifact = await voicePackage(root);
  const installer = await readFile(resolve(root, "templates/ai-dev-k8s/scripts/install-voice.py"));
  const compressedInstaller = gzipSync(installer, { level: 9 });
  if (!installer.length || installer.length > 65536 || compressedInstaller.length > 24576)
    throw new Error("Voice installer exceeds bootstrap bounds");
  const outputs = new Map([
    ["voice.tar.gz", artifact.compressed],
    ["voice.tar.sha256", Buffer.from(`${artifact.archiveSha256}\n`)],
    ["voice.manifest.sha256", Buffer.from(`${artifact.manifestSha256}\n`)],
    ["voice-installer.py.gz", compressedInstaller],
    ["voice-installer.sha256", Buffer.from(`${sha(installer)}\n`)],
  ]);
  const directory = resolve(root, "templates/ai-dev-k8s/assets");
  if (!check) await mkdir(directory, { recursive: true });
  for (const [name, bytes] of outputs) {
    const path = resolve(directory, name);
    if (check) {
      if (!(await readFile(path)).equals(bytes)) throw new Error("Voice package is stale");
    } else await writeFile(path, bytes);
  }
  return artifact;
}
