import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packReleaseArtifact } from "../../../../scripts/release/artifact.mjs";

/** Credential-free local compatibility input, never a provider publication. */
export async function packSourceBuild(root) {
  const files = new Map();
  let total = 0;
  async function collect(directory, relative, prefix, select) {
    const full = join(directory, relative),
      parent = await lstat(full);
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw Error("source_build_directory");
    for (const entry of await readdir(full, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const disk = join(directory, path),
        stat = await lstat(disk);
      if (stat.isSymbolicLink()) throw Error("source_build_symlink");
      if (stat.isDirectory()) {
        await collect(directory, path, prefix, select);
        continue;
      }
      if (!stat.isFile()) throw Error("source_build_entry");
      if (!select(path)) continue;
      if (
        stat.size > 64 * 1024 * 1024 ||
        total + stat.size > 120 * 1024 * 1024 ||
        files.size >= 10000
      )
        throw Error("source_build_limit");
      total += stat.size;
      const bytes = await readFile(disk);
      if (bytes.length !== stat.size) throw Error("source_build_changed");
      files.set(`${prefix}/${path}`, bytes);
    }
  }
  await collect(
    join(root, "build/app"),
    "",
    "app",
    (path) => path === "worker.js" || path.endsWith(".wasm"),
  );
  await collect(join(root, ".open-next/assets"), "", "assets", () => true);
  if (!files.has("app/worker.js")) throw Error("source_build_missing_worker");
  await writeFile(join(root, "release.tar"), await packReleaseArtifact(files), {
    flag: "wx",
    mode: 0o600,
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error("source_build_arguments");
    await packSourceBuild(resolve(process.argv[2]));
  } catch {
    process.stderr.write("Local database compatibility packaging failed.\n");
    process.exitCode = 1;
  }
}
