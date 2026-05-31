import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CLONE_TERMINAL_SESSION_PREFIX } from "@/lib/git/clone-terminal-session";

export {
  CLONE_TERMINAL_SESSION_PREFIX,
  isCloneTerminalSessionName,
} from "@/lib/git/clone-terminal-session";

export const CLONE_TREE_ROOT_LABEL = "Git" as const;
export const CLONE_TREE_PROJECTS_LABEL = "projects" as const;

export type CloneTreeNodeKind = "directory" | "repository";
export type CloneTreeSkippedPathReason =
  | "outside-root"
  | "not-directory"
  | "permission-denied"
  | "too-deep"
  | "invalid-path"
  | "scan-error";

export interface CloneTreeRootMetadata {
  /** Stable identifier for the configured root node. Does not contain the absolute path. */
  id: string;
  /** Normalized absolute path used server-side for containment checks. */
  path: string;
  /** User-facing root label. Defaults to Git. */
  label: string;
  /** User-facing first child under the root. Defaults to projects. */
  projectsLabel: string;
  /** Display-only hierarchy prefix, normally Git -> projects. */
  displaySegments: readonly [string, string];
}

export interface NormalizedClonePath {
  /** Normalized absolute root path used for safe containment checks. */
  rootPath: string;
  /** Normalized absolute clone path. Keep server-side unless explicitly needed. */
  absolutePath: string;
  /** Root-relative clone path using POSIX separators for stable IDs and payloads. */
  relativePath: string;
  /** Root-relative clone path split into display-safe hierarchy segments. */
  relativePathSegments: readonly string[];
  /** Display hierarchy, normally Git -> projects -> org/group -> clone. */
  displaySegments: readonly [string, string, ...string[]];
}

export interface CloneTreeBaseNode {
  id: string;
  kind: CloneTreeNodeKind;
  label: string;
  relativePath: string;
  relativePathSegments: readonly string[];
  displaySegments: readonly [string, string, ...string[]];
}

export interface CloneTreeDirectoryNode extends CloneTreeBaseNode {
  kind: "directory";
  children: readonly CloneTreeNode[];
}

export interface CloneTreeRepositoryNode extends CloneTreeBaseNode {
  kind: "repository";
  cloneSessionKey: string;
}

export type CloneTreeNode = CloneTreeDirectoryNode | CloneTreeRepositoryNode;

export interface CloneTreeSkippedPath {
  /** Root-relative path when containment could be established; otherwise a display-safe label. */
  relativePath: string;
  reason: CloneTreeSkippedPathReason;
}

export interface CloneTreeDiagnostics {
  /** User-facing root label; avoids exposing terminal text or file contents. */
  rootLabel: string;
  /** Number of repositories included in the returned tree. */
  repoCount: number;
  /** Number of directories included in the returned tree. */
  directoryCount: number;
  /** Paths skipped during scanning, represented without file contents. */
  skippedPaths: readonly CloneTreeSkippedPath[];
  /** True when scanning stopped before exhausting the root. */
  truncated: boolean;
  /** Wall-clock scan duration in milliseconds. */
  durationMs: number;
}

export interface CloneTree {
  root: CloneTreeRootMetadata;
  nodes: readonly CloneTreeNode[];
  diagnostics: CloneTreeDiagnostics;
}

export interface CloneTreeDisplayOptions {
  rootLabel?: string;
  projectsLabel?: string;
}

export function createCloneTreeRootMetadata(
  rootPath: string,
  options: CloneTreeDisplayOptions = {},
): CloneTreeRootMetadata {
  const label = normalizeDisplayLabel(options.rootLabel, CLONE_TREE_ROOT_LABEL);
  const projectsLabel = normalizeDisplayLabel(options.projectsLabel, CLONE_TREE_PROJECTS_LABEL);
  const normalizedRootPath = normalizeAbsolutePath(rootPath);
  const displaySegments = [label, projectsLabel] as const;

  return {
    id: createCloneTreeNodeId("directory", displaySegments),
    path: normalizedRootPath,
    label,
    projectsLabel,
    displaySegments,
  };
}

export function normalizeRootContainedClonePath(
  rootPath: string,
  clonePath: string,
  options: CloneTreeDisplayOptions = {},
): NormalizedClonePath | null {
  const normalizedRootPath = normalizeAbsolutePath(rootPath);
  const normalizedClonePath = normalizeCandidatePath(normalizedRootPath, clonePath);
  const rootRelativePath = relative(normalizedRootPath, normalizedClonePath);

  if (!rootRelativePath || rootRelativePath.startsWith("..") || isAbsolute(rootRelativePath)) {
    return null;
  }

  const relativePathSegments = splitPathSegments(rootRelativePath);
  if (relativePathSegments.length === 0) {
    return null;
  }

  const displaySegments = deriveCloneDisplaySegments(relativePathSegments, options);

  return {
    rootPath: normalizedRootPath,
    absolutePath: normalizedClonePath,
    relativePath: toStableRelativePath(relativePathSegments),
    relativePathSegments,
    displaySegments,
  };
}

export function deriveCloneDisplaySegments(
  relativePathSegments: readonly string[],
  options: CloneTreeDisplayOptions = {},
): readonly [string, string, ...string[]] {
  const label = normalizeDisplayLabel(options.rootLabel, CLONE_TREE_ROOT_LABEL);
  const projectsLabel = normalizeDisplayLabel(options.projectsLabel, CLONE_TREE_PROJECTS_LABEL);
  const safeRelativeSegments = relativePathSegments.filter(Boolean);

  return [label, projectsLabel, ...safeRelativeSegments];
}

export function createCloneTreeNodeId(
  kind: CloneTreeNodeKind,
  displaySegments: readonly string[],
): string {
  return `git-${kind}:${encodeHierarchySegments(displaySegments)}`;
}

export function createCloneSessionKey(displaySegments: readonly string[]): string {
  return `git-clone:${encodeHierarchySegments(displaySegments)}`;
}

export function createSafeCloneTerminalSessionName(cloneSessionKey: string): string {
  const digest = createHash("sha256").update(cloneSessionKey).digest("hex").slice(0, 32);
  return `${CLONE_TERMINAL_SESSION_PREFIX}${digest}`;
}

export function createCloneTreeDirectoryNode(
  normalizedPath: NormalizedClonePath,
  children: readonly CloneTreeNode[] = [],
): CloneTreeDirectoryNode {
  return {
    id: createCloneTreeNodeId("directory", normalizedPath.displaySegments),
    kind: "directory",
    label: lastSegment(normalizedPath.displaySegments),
    relativePath: normalizedPath.relativePath,
    relativePathSegments: normalizedPath.relativePathSegments,
    displaySegments: normalizedPath.displaySegments,
    children,
  };
}

export function createCloneTreeRepositoryNode(
  normalizedPath: NormalizedClonePath,
): CloneTreeRepositoryNode {
  return {
    id: createCloneTreeNodeId("repository", normalizedPath.displaySegments),
    kind: "repository",
    label: lastSegment(normalizedPath.displaySegments),
    relativePath: normalizedPath.relativePath,
    relativePathSegments: normalizedPath.relativePathSegments,
    displaySegments: normalizedPath.displaySegments,
    cloneSessionKey: createCloneSessionKey(normalizedPath.displaySegments),
  };
}

function normalizeAbsolutePath(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    throw new Error("Clone tree root path is required");
  }

  return resolve(trimmedPath);
}

function normalizeCandidatePath(rootPath: string, candidatePath: string): string {
  const trimmedPath = candidatePath.trim();
  if (!trimmedPath) {
    throw new Error("Clone path is required");
  }

  return isAbsolute(trimmedPath) ? resolve(trimmedPath) : resolve(rootPath, trimmedPath);
}

function splitPathSegments(path: string): string[] {
  return path.split(sep).filter(Boolean);
}

function normalizeDisplayLabel(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function toStableRelativePath(pathSegments: readonly string[]): string {
  return pathSegments.join("/");
}

function encodeHierarchySegments(segments: readonly string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function lastSegment(segments: readonly string[]): string {
  return segments[segments.length - 1] ?? "";
}
