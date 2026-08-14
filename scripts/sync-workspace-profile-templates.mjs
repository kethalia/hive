/* eslint-disable security/detect-non-literal-fs-filename -- Every path is derived from repository-owned template roots. */
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

const repositoryRoot = process.cwd();
const canonicalRoot = join(repositoryRoot, "templates", "ai-dev-k8s");
const targetRoots = [
  join(repositoryRoot, "templates", "orchestrator"),
  join(repositoryRoot, "templates", "browser-testing"),
  join(repositoryRoot, "templates", "game-dev"),
  join(repositoryRoot, "templates", "electronics"),
  join(repositoryRoot, "templates", "infrastructure"),
];
const checkOnly = process.argv.includes("--check");

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

const canonicalScripts = await collectFiles(join(canonicalRoot, "scripts"));
const sharedRelativePaths = [
  ".terraform.lock.hcl",
  "main.tf",
  ...canonicalScripts.map((file) => relative(canonicalRoot, file)),
].sort();
const drift = [];

for (const targetRoot of targetRoots) {
  for (const relativePath of sharedRelativePaths) {
    const source = join(canonicalRoot, relativePath);
    const target = join(targetRoot, relativePath);

    if (checkOnly) {
      try {
        const [sourceContent, targetContent] = await Promise.all([
          readFile(source),
          readFile(target),
        ]);
        if (!sourceContent.equals(targetContent)) drift.push(relative(repositoryRoot, target));
      } catch {
        drift.push(relative(repositoryRoot, target));
      }
      continue;
    }

    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

if (checkOnly && drift.length > 0) {
  console.error("Workspace profile templates are out of sync:");
  for (const file of drift) console.error(`- ${file}`);
  console.error("Run pnpm templates:sync and commit the generated scaffold updates.");
  process.exitCode = 1;
} else if (checkOnly) {
  console.log(`Workspace profile scaffolds are synchronized (${targetRoots.length} variants).`);
} else {
  console.log(`Synchronized ${targetRoots.length} workspace profile scaffolds.`);
}
