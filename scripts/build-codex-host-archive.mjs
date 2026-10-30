// Deterministic, template-pinned package. Nothing is downloaded by this builder.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tar from "tar-stream";
import { encodeHostArchive } from "./host-archive-codec.mjs";

export async function hostArchive(root) {
  const temporary = await mkdtemp(join(tmpdir(), "hive-host-archive-"));
  try {
    const directory = join(temporary, "package");
    execFileSync(process.execPath, [join(root, "scripts/build-codex-host-bundle.mjs"), directory], {
      cwd: root,
      stdio: "pipe",
    });
    const manifest = JSON.parse(await readFile(join(directory, "package-manifest.json"), "utf8"));
    const pack = tar.pack();
    const chunks = [];
    const collected = (async () => {
      for await (const chunk of pack) chunks.push(chunk);
    })();
    for (const name of [...Object.keys(manifest.files), "package-manifest.json"].sort()) {
      pack.entry(
        {
          name,
          type: "file",
          mode: name.endsWith(".json") ? 0o400 : 0o500,
          uid: 0,
          gid: 0,
          mtime: new Date(0),
        },
        await readFile(join(directory, name)),
      );
    }
    pack.finalize();
    await collected;
    const archive = Buffer.concat(chunks);
    if (archive.length > 2 * 1024 * 1024) throw new Error("Host archive exceeds installer bounds");
    const compressed = encodeHostArchive(archive);
    if (compressed.length > 160000) throw new Error("Host archive exceeds pod metadata budget");
    return { archive, compressed, sha256: createHash("sha256").update(archive).digest("hex") };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function syncHostArchive(root, check = false) {
  const artifact = await hostArchive(root);
  const destination = join(root, "templates/ai-dev-k8s/assets/codex-host.tar");
  const checksum = Buffer.from(`${artifact.sha256}\n`);
  if (check) {
    if (
      !(await readFile(`${destination}.sha256`)).equals(checksum) ||
      !(await readFile(`${destination}.xz`)).equals(artifact.compressed)
    )
      throw new Error("Host package is stale; run pnpm templates:sync");
  } else {
    await mkdir(join(root, "templates/ai-dev-k8s/assets"), { recursive: true });
    await writeFile(`${destination}.sha256`, checksum);
    await writeFile(`${destination}.xz`, artifact.compressed);
    await rm(destination, { force: true });
    await rm(`${destination}.gz`, { force: true });
  }
  return artifact.sha256;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncHostArchive(process.cwd(), process.argv.includes("--check"));
}
