import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CloneTree,
  CloneTreeDisplayOptions,
  CloneTreeNode,
  CloneTreeSkippedPath,
  CloneTreeSkippedPathReason,
  NormalizedClonePath,
} from "./clone-tree";
import {
  createCloneTreeDirectoryNode,
  createCloneTreeRepositoryNode,
  createCloneTreeRootMetadata,
  normalizeRootContainedClonePath,
} from "./clone-tree";

export const DEFAULT_CLONE_DISCOVERY_MAX_DEPTH = 5;
export const DEFAULT_CLONE_DISCOVERY_MAX_REPOSITORIES = 200;
export const DEFAULT_SKIPPED_DIRECTORY_NAMES = [
  ".cache",
  ".claude",
  ".config",
  ".docker",
  ".gnupg",
  ".kube",
  ".local",
  ".npm",
  ".pnpm-store",
  ".ssh",
  ".vscode-server",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
] as const;

export interface DiscoverProjectCloneTreeOptions extends CloneTreeDisplayOptions {
  /** Maximum root-relative directory depth to inspect. A clone at this depth is still included. */
  maxDepth?: number;
  /** Maximum number of repositories to include before truncating the scan. */
  maxRepositories?: number;
  /** Directory basenames that should never be traversed. */
  skippedDirectoryNames?: readonly string[];
  /** Injectable clock for deterministic diagnostics tests. */
  now?: () => number;
}

type GitMetadataState = "repository" | "not-repository" | "permission-denied" | "scan-error";

interface ScanContext {
  readonly rootPath: string;
  readonly displayOptions: CloneTreeDisplayOptions;
  readonly maxDepth: number;
  readonly maxRepositories: number;
  readonly skippedDirectoryNames: ReadonlySet<string>;
  readonly repositories: NormalizedClonePath[];
  readonly skippedPaths: CloneTreeSkippedPath[];
  truncated: boolean;
}

interface MutableDirectoryNode {
  readonly normalizedPath: NormalizedClonePath;
  readonly directories: Map<string, MutableDirectoryNode>;
  readonly repositories: NormalizedClonePath[];
}

export async function discoverProjectCloneTree(
  projectsRootPath: string,
  options: DiscoverProjectCloneTreeOptions = {},
): Promise<CloneTree> {
  const root = createCloneTreeRootMetadata(projectsRootPath, options);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const displayOptions: CloneTreeDisplayOptions = {
    projectsLabel: root.projectsLabel,
    rootLabel: root.label,
  };
  const context: ScanContext = {
    rootPath: root.path,
    displayOptions,
    maxDepth: normalizeNonNegativeInteger(options.maxDepth, DEFAULT_CLONE_DISCOVERY_MAX_DEPTH),
    maxRepositories: normalizePositiveInteger(
      options.maxRepositories,
      DEFAULT_CLONE_DISCOVERY_MAX_REPOSITORIES,
    ),
    skippedDirectoryNames: new Set(
      options.skippedDirectoryNames ?? DEFAULT_SKIPPED_DIRECTORY_NAMES,
    ),
    repositories: [],
    skippedPaths: [],
    truncated: false,
  };

  try {
    const rootStats = await lstat(root.path);

    if (!rootStats.isDirectory()) {
      addSkippedPath(context, [], "not-directory");
    } else {
      await scanDirectory(root.path, [], context);
    }
  } catch (error) {
    addSkippedPath(context, [], mapFilesystemErrorToSkippedReason(error, "not-directory"));
  }

  const { directoryCount, nodes } = buildCloneTreeNodes(
    root.path,
    context.repositories,
    displayOptions,
  );
  const durationMs = Math.max(0, Math.round(now() - startedAt));

  return {
    root,
    nodes,
    diagnostics: {
      rootLabel: root.label,
      repoCount: context.repositories.length,
      directoryCount,
      skippedPaths: context.skippedPaths,
      truncated: context.truncated,
      durationMs,
    },
  };
}

async function scanDirectory(
  directoryPath: string,
  relativePathSegments: readonly string[],
  context: ScanContext,
): Promise<void> {
  if (context.truncated && context.repositories.length >= context.maxRepositories) {
    return;
  }

  const gitMetadataState = await readGitMetadataState(directoryPath);

  if (gitMetadataState === "repository") {
    addRepository(directoryPath, relativePathSegments, context);
    return;
  }

  if (gitMetadataState === "permission-denied" || gitMetadataState === "scan-error") {
    addSkippedPath(context, relativePathSegments, gitMetadataState);
    return;
  }

  if (relativePathSegments.length >= context.maxDepth) {
    if (relativePathSegments.length > 0) {
      context.truncated = true;
      addSkippedPath(context, relativePathSegments, "too-deep");
    }
    return;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    addSkippedPath(
      context,
      relativePathSegments,
      mapFilesystemErrorToSkippedReason(error, "scan-error"),
    );
    return;
  }

  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sortedEntries) {
    if (context.repositories.length >= context.maxRepositories) {
      context.truncated = true;
      return;
    }

    const childRelativePathSegments = [...relativePathSegments, entry.name];

    if (entry.isSymbolicLink()) {
      addSkippedPath(context, childRelativePathSegments, "invalid-path");
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    if (isHiddenDirectoryName(entry.name) || context.skippedDirectoryNames.has(entry.name)) {
      addSkippedPath(context, childRelativePathSegments, "invalid-path");
      continue;
    }

    await scanDirectory(join(directoryPath, entry.name), childRelativePathSegments, context);
  }
}

function isHiddenDirectoryName(name: string): boolean {
  return name.startsWith(".");
}

function addRepository(
  directoryPath: string,
  relativePathSegments: readonly string[],
  context: ScanContext,
): void {
  if (context.repositories.length >= context.maxRepositories) {
    context.truncated = true;
    return;
  }

  const normalizedPath = normalizeRootContainedClonePath(
    context.rootPath,
    directoryPath,
    context.displayOptions,
  );

  if (!normalizedPath) {
    addSkippedPath(context, relativePathSegments, "outside-root");
    return;
  }

  context.repositories.push(normalizedPath);
}

async function readGitMetadataState(directoryPath: string): Promise<GitMetadataState> {
  try {
    const gitMetadataStats = await lstat(join(directoryPath, ".git"));

    return gitMetadataStats.isDirectory() || gitMetadataStats.isFile()
      ? "repository"
      : "not-repository";
  } catch (error) {
    const code = getFilesystemErrorCode(error);

    if (code === "ENOENT" || code === "ENOTDIR") {
      return "not-repository";
    }

    return isPermissionErrorCode(code) ? "permission-denied" : "scan-error";
  }
}

function buildCloneTreeNodes(
  rootPath: string,
  repositories: readonly NormalizedClonePath[],
  displayOptions: CloneTreeDisplayOptions,
): { directoryCount: number; nodes: readonly CloneTreeNode[] } {
  const rootDirectories = new Map<string, MutableDirectoryNode>();
  const rootRepositories: NormalizedClonePath[] = [];
  const sortedRepositories = [...repositories].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );

  for (const repository of sortedRepositories) {
    if (repository.relativePathSegments.length === 1) {
      rootRepositories.push(repository);
      continue;
    }

    let currentDirectories = rootDirectories;

    for (let index = 0; index < repository.relativePathSegments.length - 1; index += 1) {
      const segment = repository.relativePathSegments[index];
      const prefixSegments = repository.relativePathSegments.slice(0, index + 1);
      let directory = currentDirectories.get(segment);

      if (!directory) {
        const normalizedDirectoryPath = normalizeRootContainedClonePath(
          rootPath,
          prefixSegments.join("/"),
          displayOptions,
        );

        if (!normalizedDirectoryPath) {
          break;
        }

        directory = {
          normalizedPath: normalizedDirectoryPath,
          directories: new Map(),
          repositories: [],
        };
        currentDirectories.set(segment, directory);
      }

      if (index === repository.relativePathSegments.length - 2) {
        directory.repositories.push(repository);
      }

      currentDirectories = directory.directories;
    }
  }

  let directoryCount = 0;

  function materializeDirectory(directory: MutableDirectoryNode): CloneTreeNode {
    directoryCount += 1;

    return createCloneTreeDirectoryNode(
      directory.normalizedPath,
      [
        ...sortMutableDirectories(directory.directories).map(materializeDirectory),
        ...directory.repositories.map(createCloneTreeRepositoryNode),
      ].sort(compareCloneTreeNodes),
    );
  }

  const nodes = [
    ...sortMutableDirectories(rootDirectories).map(materializeDirectory),
    ...rootRepositories.map(createCloneTreeRepositoryNode),
  ].sort(compareCloneTreeNodes);

  return { directoryCount, nodes };
}

function sortMutableDirectories(
  directories: ReadonlyMap<string, MutableDirectoryNode>,
): MutableDirectoryNode[] {
  return [...directories.values()].sort((left, right) =>
    left.normalizedPath.relativePath.localeCompare(right.normalizedPath.relativePath),
  );
}

function compareCloneTreeNodes(left: CloneTreeNode, right: CloneTreeNode): number {
  return (
    left.label.localeCompare(right.label) ||
    left.kind.localeCompare(right.kind) ||
    left.relativePath.localeCompare(right.relativePath)
  );
}

function addSkippedPath(
  context: ScanContext,
  relativePathSegments: readonly string[],
  reason: CloneTreeSkippedPathReason,
): void {
  context.skippedPaths.push({
    relativePath: formatSkippedRelativePath(relativePathSegments),
    reason,
  });
}

function formatSkippedRelativePath(relativePathSegments: readonly string[]): string {
  return relativePathSegments.length > 0 ? relativePathSegments.join("/") : ".";
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function mapFilesystemErrorToSkippedReason(
  error: unknown,
  fallback: CloneTreeSkippedPathReason,
): CloneTreeSkippedPathReason {
  const code = getFilesystemErrorCode(error);

  if (isPermissionErrorCode(code)) {
    return "permission-denied";
  }

  if (code === "ENOENT" || code === "ENOTDIR") {
    return "not-directory";
  }

  return fallback;
}

function isPermissionErrorCode(code: string | undefined): boolean {
  return code === "EACCES" || code === "EPERM";
}

function getFilesystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
