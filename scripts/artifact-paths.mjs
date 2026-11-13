import { lstat } from "node:fs/promises";
import { join, parse, resolve } from "node:path";

/** Build inputs and outputs must not cross symlinked ancestor directories. */
export async function assertArtifactPath(path, { directory = false, allowMissing = false } = {}) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split("/").filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())
    )
      throw new Error("Artifact path contains a non-regular input or symlink");
  }
}
