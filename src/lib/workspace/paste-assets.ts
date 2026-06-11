import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { DEFAULT_EXEC_TIMEOUT_MS } from "@/lib/constants";
import { execInWorkspace } from "@/lib/workspace/exec";

export const TERMINAL_PASTE_ASSET_TARGET_DIR = "/tmp/hive-terminal-paste";
export const TERMINAL_PASTE_ASSET_MAX_FILES = 4;
export const TERMINAL_PASTE_ASSET_MAX_BYTES = 5 * 1024 * 1024;
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
}: {
  userId: string;
  workspaceId: string;
  files: readonly TerminalPasteAssetUpload[];
}): Promise<string[]> {
  if (files.length === 0) throw new Error("No files provided");
  if (files.length > TERMINAL_PASTE_ASSET_MAX_FILES) {
    throw new Error(`Paste up to ${TERMINAL_PASTE_ASSET_MAX_FILES} files at once`);
  }

  const plannedUploads = files.map((file) => {
    if (file.bytes.byteLength > TERMINAL_PASTE_ASSET_MAX_BYTES) {
      throw new Error("Pasted file is too large");
    }

    return {
      bytes: file.bytes,
      path: `${TERMINAL_PASTE_ASSET_TARGET_DIR}/${randomUUID()}-${sanitizePasteAssetName(
        file.name,
        file.type,
      )}`,
    };
  });

  const client = await getCoderClientForUser(userId);
  const agentTarget = await client.getWorkspaceAgentName(workspaceId);

  const mkdirResult = await execInWorkspace(
    agentTarget,
    `umask 077 && mkdir -p ${shellQuote(TERMINAL_PASTE_ASSET_TARGET_DIR)}`,
    {
      coderUrl: client.getBaseUrl(),
      sessionToken: client.getSessionToken(),
      timeoutMs: Math.max(DEFAULT_EXEC_TIMEOUT_MS, 120_000),
    },
  );

  if (mkdirResult.exitCode !== 0) {
    throw new Error("Failed to store pasted file in workspace");
  }

  for (const upload of plannedUploads) {
    await writePasteAssetToWorkspace({
      agentTarget,
      baseUrl: client.getBaseUrl(),
      sessionToken: client.getSessionToken(),
      path: upload.path,
      bytes: upload.bytes,
      timeoutMs: Math.max(DEFAULT_EXEC_TIMEOUT_MS, 120_000),
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
}: {
  agentTarget: string;
  baseUrl: string;
  sessionToken: string;
  path: string;
  bytes: Uint8Array;
  timeoutMs: number;
}): Promise<void> {
  const env = {
    ...process.env,
    CODER_URL: baseUrl,
    CODER_SESSION_TOKEN: sessionToken,
  };
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
      `bash -lc ${shellQuote(`base64 -d > ${shellQuote(path)}`)}`,
    ],
    {
      env,
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  const encoded = Buffer.from(bytes).toString("base64");

  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Failed to store pasted file in workspace"));
    }, timeoutMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Failed to store pasted file in workspace"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      if (stderr.trim()) {
        console.warn("[paste-assets] workspace file write failed");
      }
      reject(new Error("Failed to store pasted file in workspace"));
    });

    child.stdin.end(encoded);
  });
}
