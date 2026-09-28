import { posix } from "node:path";

export function resolveTerminalFilePath(
  path: string,
  cwd: string | undefined,
  root: string,
): string {
  if (Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error("Invalid file path");
  // All provisioned profiles use /home/coder as their home directory.
  const expanded = path.startsWith("~/") ? `/home/coder/${path.slice(2)}` : path;
  if (!expanded.startsWith("/") && !cwd) {
    throw new Error("Could not determine the terminal's current directory");
  }
  const resolved = posix.resolve(cwd ?? "/", expanded);
  const normalizedRoot = posix.resolve(root);
  if (
    normalizedRoot !== "/" &&
    resolved !== normalizedRoot &&
    !resolved.startsWith(`${normalizedRoot}/`)
  ) {
    throw new Error("This path is outside the File Browser root");
  }
  return resolved;
}
