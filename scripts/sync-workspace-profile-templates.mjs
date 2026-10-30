/* eslint-disable security/detect-non-literal-fs-filename -- Every path is derived from repository-owned template roots. */
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { syncHostArchive } from "./build-codex-host-archive.mjs";
import { buildTemplateArtifacts } from "./build-template-artifacts.mjs";
import { syncWorkspaceReadPackage } from "./build-workspace-read-package.mjs";
import { syncVoicePackage } from "./voice/build-package.mjs";

const repositoryRoot = process.cwd();
const canonicalRoot = join(repositoryRoot, "templates", "ai-dev-k8s");
const targetRoots = [
  join(repositoryRoot, "templates", "browser-testing"),
  join(repositoryRoot, "templates", "game-dev"),
  join(repositoryRoot, "templates", "electronics"),
  join(repositoryRoot, "templates", "infrastructure"),
];
const checkOnly = process.argv.includes("--check");
await syncHostArchive(repositoryRoot, checkOnly);
await syncWorkspaceReadPackage(repositoryRoot, checkOnly);
await syncVoicePackage(repositoryRoot, checkOnly);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === "__pycache__" && entry.isDirectory()) continue;
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
const canonicalScriptRelativePaths = new Set(
  canonicalScripts.map((file) => relative(canonicalRoot, file)),
);
const sharedRelativePaths = [
  ".terraform.lock.hcl",
  "main.tf",
  "hive-host.tf",
  "hive-read.tf",
  "hive-voice.tf",
  "assets/voice.tar.gz",
  "assets/voice.tar.sha256",
  "assets/voice.manifest.sha256",
  "assets/voice-installer.py.gz",
  "assets/voice-installer.sha256",
  "assets/codex-host.tar.sha256",
  "assets/codex-host.tar.xz",
  "assets/workspace-read.tar.gz",
  "assets/workspace-read-installer.py.gz",
  "assets/workspace-read-installer.sha256",
  "assets/workspace-read.tar.sha256",
  "assets/workspace-read.manifest.sha256",
  "WORKSPACE_ROUTING.md",
  ...canonicalScriptRelativePaths,
].sort();
const drift = [];
let removedScripts = 0;

for (const targetRoot of targetRoots) {
  for (const obsolete of ["assets/codex-host.tar", "assets/codex-host.tar.gz"]) {
    try {
      await readFile(join(targetRoot, obsolete));
      if (checkOnly) drift.push(relative(repositoryRoot, join(targetRoot, obsolete)));
      else await rm(join(targetRoot, obsolete));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const targetScripts = await collectFiles(join(targetRoot, "scripts"));
  const obsoleteScripts = targetScripts
    .map((file) => relative(targetRoot, file))
    .filter((relativePath) => !canonicalScriptRelativePaths.has(relativePath))
    .sort();

  for (const relativePath of obsoleteScripts) {
    const target = join(targetRoot, relativePath);
    if (checkOnly) {
      drift.push(relative(repositoryRoot, target));
    } else {
      await rm(target);
      removedScripts += 1;
    }
  }

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
  const cleanup = removedScripts > 0 ? `; removed ${removedScripts} obsolete scripts` : "";
  console.log(`Synchronized ${targetRoots.length} workspace profile scaffolds${cleanup}.`);
}

if (!process.exitCode)
  await buildTemplateArtifacts(repositoryRoot, checkOnly ? "check" : "manifest");
