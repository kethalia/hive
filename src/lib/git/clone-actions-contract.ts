import { posix } from "node:path";
import type { CloneTree, CloneTreeDiagnostics } from "@/lib/git/clone-tree";

export const PROJECTS_ROOT_ENV_KEY = "HIVE_PROJECTS_ROOT";
export const DEFAULT_PROJECTS_ROOT_PATH = "/home/coder";

export type PublicCloneTree = Omit<CloneTree, "root"> & {
  root: Omit<CloneTree["root"], "path">;
};

export type GitCloneDiscoveryErrorCode = "missing-root" | "scan-failed";
export type GitCloneDiscoveryStatus = "success" | "empty" | GitCloneDiscoveryErrorCode;

export type GitCloneDiscoveryActionResult =
  | {
      ok: true;
      status: "success" | "empty";
      message: string;
      tree: PublicCloneTree;
      diagnostics: CloneTreeDiagnostics;
      error: null;
    }
  | {
      ok: false;
      status: GitCloneDiscoveryErrorCode;
      message: string;
      tree: null;
      diagnostics: CloneTreeDiagnostics | null;
      error: {
        code: GitCloneDiscoveryErrorCode;
        message: string;
      };
    };

export interface GitCloneTerminalIdentity {
  sessionName: string;
  clonePath: string;
  cloneSessionKey: string;
  cloneProof: string;
}

export function resolveConfiguredProjectsRoot(): string {
  const configuredRoot = process.env[PROJECTS_ROOT_ENV_KEY]?.trim();
  if (!configuredRoot) return DEFAULT_PROJECTS_ROOT_PATH;

  if (!isAbsolutePosixPath(configuredRoot)) {
    throw new Error(`${PROJECTS_ROOT_ENV_KEY} must be an absolute POSIX path`);
  }

  return normalizeAbsolutePosixPath(configuredRoot);
}

function isAbsolutePosixPath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\\") && !value.includes("\0");
}

function normalizeAbsolutePosixPath(value: string): string {
  const normalized = posix.normalize(value);
  return normalized !== "/" && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
