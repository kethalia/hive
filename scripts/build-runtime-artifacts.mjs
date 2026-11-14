import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertArtifactPath } from "./artifact-paths.mjs";

const paths = [
  "scripts/notifications/install.py",
  "scripts/notifications/agent-hook.py",
  "templates/ai-dev-k8s/scripts/agent-tools.py",
];
export async function buildRuntimeArtifacts(root = process.cwd()) {
  const directory = join(root, "public/hive-runtime-artifacts");
  await assertArtifactPath(directory, { directory: true, allowMissing: true });
  const manifestPath = join(root, "src/lib/workspace/runtime-artifact-manifest.json");
  await assertArtifactPath(manifestPath, { allowMissing: true });
  const manifest = {};
  const inputs = [];
  // Validate every source before replacing the previous build-owned output.
  for (const path of paths) {
    await assertArtifactPath(join(root, path));
    const data = await readFile(join(root, path));
    if (data.length > 524288) throw new Error("Runtime artifact exceeds its size limit");
    manifest[path] = {
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    inputs.push([path, data]);
  }
  await rm(directory, { recursive: true, force: true });
  for (const [path, data] of inputs) {
    const target = join(directory, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, data);
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href)
  await buildRuntimeArtifacts();
