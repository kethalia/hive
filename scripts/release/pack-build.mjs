import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packReleaseArtifact } from "./artifact.mjs";

// Runs in the credential-free builder. The publisher independently validates
// every archive entry and does not trust this script's conclusions.
async function main() {
  const files = new Map();
  let total = 0;
  async function collect(root, relative, prefix, select) {
    const full = join(root, relative);
    const entries = await readdir(full, { withFileTypes: true });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const disk = join(root, path);
      const stat = await lstat(disk);
      if (stat.isSymbolicLink()) throw Error("build_symlink");
      if (stat.isDirectory()) {
        await collect(root, path, prefix, select);
        continue;
      }
      if (!stat.isFile()) throw Error("build_entry");
      if (!select(path)) continue;
      if (
        stat.size > 64 * 1024 * 1024 ||
        total + stat.size > 120 * 1024 * 1024 ||
        files.size >= 10000
      )
        throw Error("build_limit");
      total += stat.size;
      const data = await readFile(disk);
      if (data.length !== stat.size) throw Error("build_changed");
      files.set(`${prefix}/${path}`, data);
    }
  }
  const workerPart = (path) => path === "worker.js" || path.endsWith(".wasm");
  await collect("build/app", "", "app", workerPart);
  await collect("build/auth", "", "auth", workerPart);
  await collect(".open-next/assets", "", "assets", () => true);
  if (!files.has("app/worker.js") || !files.has("auth/worker.js"))
    throw Error("build_missing_worker");
  await writeFile("release.tar", await packReleaseArtifact(files), { flag: "wx", mode: 0o600 });
}
main().catch(() => {
  process.stderr.write("Release build packaging failed.\n");
  process.exitCode = 1;
});
