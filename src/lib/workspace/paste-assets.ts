import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { DEFAULT_EXEC_TIMEOUT_MS } from "@/lib/constants";
import {
  TERMINAL_PASTE_ASSET_MAX_BYTES,
  TERMINAL_PASTE_ASSET_MAX_FILES,
  TERMINAL_PASTE_ASSET_MAX_TOTAL_BYTES,
} from "@/lib/terminal/paste-limits";

export {
  TERMINAL_PASTE_ASSET_MAX_BYTES,
  TERMINAL_PASTE_ASSET_MAX_FILES,
} from "@/lib/terminal/paste-limits";

export const TERMINAL_PASTE_ASSET_TARGET_DIR = "/tmp/hive-terminal-paste";
export const TERMINAL_PASTE_ASSET_PREFERRED_MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["text/plain", "txt"],
]);
export const TERMINAL_PASTE_ASSET_MIME_EXTENSIONS = TERMINAL_PASTE_ASSET_PREFERRED_MIME_EXTENSIONS;

export interface TerminalPasteAssetUpload {
  name: string;
  type: string;
  bytes: Uint8Array;
}

function isBufferedUpload(file: TerminalPasteAssetUpload | File): file is TerminalPasteAssetUpload {
  // Newer Node versions expose Blob.bytes() too; distinguish our actual byte buffer.
  return "bytes" in file && file.bytes instanceof Uint8Array;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sanitizePasteAssetName(name: string, type: string): string {
  const fallbackExtension = TERMINAL_PASTE_ASSET_PREFERRED_MIME_EXTENSIONS.get(type);
  const fallbackName = fallbackExtension ? `clipboard.${fallbackExtension}` : "clipboard.bin";
  const sourceName = name.trim() || fallbackName;
  const normalized = sourceName
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized || fallbackName;
}

export async function uploadTerminalPasteAssets({
  userId,
  workspaceId,
  files,
  signal,
}: {
  userId: string;
  workspaceId: string;
  files: readonly (TerminalPasteAssetUpload | File)[];
  signal?: AbortSignal;
}): Promise<string[]> {
  if (files.length === 0) throw new Error("No files provided");
  if (files.length > TERMINAL_PASTE_ASSET_MAX_FILES) {
    throw new Error(`Paste up to ${TERMINAL_PASTE_ASSET_MAX_FILES} files at once`);
  }

  const sizeOf = (file: TerminalPasteAssetUpload | File) =>
    isBufferedUpload(file) ? file.bytes.byteLength : file.size;
  if (files.some((file) => sizeOf(file) > TERMINAL_PASTE_ASSET_MAX_BYTES)) {
    throw new Error("Pasted file is too large");
  }
  if (
    files.reduce((total, file) => total + sizeOf(file), 0) > TERMINAL_PASTE_ASSET_MAX_TOTAL_BYTES
  ) {
    throw new Error("Paste files must total 20 MiB or less");
  }
  signal?.throwIfAborted();
  const plannedUploads = files.map((file) => ({
    file,
    path: `${TERMINAL_PASTE_ASSET_TARGET_DIR}/${randomUUID()}-${sanitizePasteAssetName(file.name, file.type)}`,
  }));
  const client = await getCoderClientForUser(userId);
  signal?.throwIfAborted();
  const agentTarget = await client.getWorkspaceAgentName(workspaceId, signal);
  signal?.throwIfAborted();

  for (const upload of plannedUploads) {
    signal?.throwIfAborted();
    const bytes = isBufferedUpload(upload.file)
      ? upload.file.bytes
      : new Uint8Array(await upload.file.arrayBuffer());
    signal?.throwIfAborted();
    await writePasteAssetToWorkspace({
      agentTarget,
      baseUrl: client.getBaseUrl(),
      sessionToken: client.getSessionToken(),
      path: upload.path,
      bytes,
      timeoutMs: Math.max(DEFAULT_EXEC_TIMEOUT_MS, 120_000),
      signal,
    });
  }

  return plannedUploads.map((upload) => upload.path);
}

function writePasteAssetToWorkspace({
  agentTarget,
  baseUrl,
  sessionToken,
  path,
  bytes,
  timeoutMs,
  signal,
}: {
  agentTarget: string;
  baseUrl: string;
  sessionToken: string;
  path: string;
  bytes: Uint8Array;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  signal?.throwIfAborted();
  const env = {
    ...process.env,
    CODER_URL: baseUrl,
    CODER_SESSION_TOKEN: sessionToken,
  };
  const partialPath = `${path}.part`;
  const command = [
    `umask 077 && mkdir -p ${shellQuote(TERMINAL_PASTE_ASSET_TARGET_DIR)} || exit 1`,
    `trap ${shellQuote(`rm -f -- ${shellQuote(partialPath)}`)} EXIT`,
    `cat > ${shellQuote(partialPath)} && test "$(wc -c < ${shellQuote(partialPath)})" -eq ${bytes.byteLength} && mv -- ${shellQuote(partialPath)} ${shellQuote(path)}`,
  ].join("; ");
  const child = spawn(
    "ssh",
    [
      "-o",
      "LogLevel=ERROR",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ProxyCommand=coder ssh --stdio %h",
      agentTarget,
      `bash -lc ${shellQuote(command)}`,
    ],
    {
      env,
      stdio: ["pipe", "ignore", "pipe"],
      detached: process.platform !== "win32",
    },
  );

  return new Promise((resolve, reject) => {
    let hasStderr = false;
    let settled = false;
    let failed = false;
    const fail = () => {
      if (settled || failed) return;
      failed = true;
      clearTimeout(timer);
      // Kill the local process group too: SSH's ProxyCommand runs a Coder child.
      // Keep the admission slot until close confirms the streams/process exited.
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(fail, timeoutMs);

    // An early SSH exit can emit EPIPE independently of the child process.
    // Keep error listeners installed for late errors after process close.
    child.stdin.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", () => {
      hasStderr = true;
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      if (!failed && code === 0) {
        resolve();
        return;
      }
      if (hasStderr) console.warn("[paste-assets] workspace file write failed");
      reject(new Error("Failed to store pasted file in workspace"));
    });
    signal?.addEventListener("abort", fail, { once: true });
    if (signal?.aborted) {
      fail();
      return;
    }
    try {
      child.stdin.end(bytes);
    } catch {
      fail();
    }
  });
}
