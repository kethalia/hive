const CLONE_SESSION_KEY_PREFIX = "git-clone:" as const;

export interface PublicCloneIdentifier {
  cloneSessionKey: string;
  relativePath: string;
}

export function isExpectedCloneSessionKey(value: string): boolean {
  const trimmedValue = value.trim();
  if (!trimmedValue.startsWith(CLONE_SESSION_KEY_PREFIX)) {
    return false;
  }

  return isSafeSlashDelimitedPath(trimmedValue.slice(CLONE_SESSION_KEY_PREFIX.length));
}

export function isSafeCloneRelativePath(value: string): boolean {
  return isSafeSlashDelimitedPath(value.trim());
}

export function getCloneSessionKeySuffix(cloneSessionKey: string): string | null {
  const trimmedValue = cloneSessionKey.trim();
  if (!trimmedValue.startsWith(CLONE_SESSION_KEY_PREFIX)) {
    return null;
  }

  const suffix = trimmedValue.slice(CLONE_SESSION_KEY_PREFIX.length);
  return isSafeSlashDelimitedPath(suffix) ? suffix : null;
}

export function getCloneDisplayLabel(relativePath: string): string | null {
  const trimmedValue = relativePath.trim();
  if (!isSafeCloneRelativePath(trimmedValue)) return null;

  const segments = trimmedValue.split("/");
  const projectsIndex = segments.lastIndexOf("projects");
  const displaySegments =
    projectsIndex >= 0 && segments.length - projectsIndex > 2
      ? segments.slice(projectsIndex + 1)
      : segments;

  return displaySegments.join("/");
}

export function isSafePublicCloneIdentifier(identifier: PublicCloneIdentifier): boolean {
  return (
    isExpectedCloneSessionKey(identifier.cloneSessionKey) &&
    isSafeCloneRelativePath(identifier.relativePath)
  );
}

function isSafeSlashDelimitedPath(value: string): boolean {
  if (
    !value ||
    value === "." ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    return false;
  }

  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}
