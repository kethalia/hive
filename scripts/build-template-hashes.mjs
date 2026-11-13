import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function files(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".terraform") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await files(join(directory, entry.name), relative)));
    else if (entry.isFile()) result.push(relative);
    else throw new Error("Template distribution contains a nonregular file");
  }
  return result.sort();
}

export async function buildTemplateHashes(root = process.cwd()) {
  const hashes = {};
  for (const name of [
    "ai-dev-k8s",
    "browser-testing",
    "game-dev",
    "electronics",
    "infrastructure",
  ]) {
    const directory = join(root, "templates", name);
    const hash = createHash("sha256");
    for (const file of await files(directory)) {
      hash.update(file);
      hash.update(await readFile(join(directory, file)));
    }
    hashes[name] = hash.digest("hex");
  }
  await writeFile(
    join(root, "src/lib/templates/cloudflare-template-hashes.json"),
    `${JSON.stringify(hashes, null, 2)}\n`,
  );
  return hashes;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href)
  await buildTemplateHashes();
