import { randomUUID } from "node:crypto";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { DEFAULT_EXEC_TIMEOUT_MS } from "@/lib/constants";
import { execInWorkspace } from "@/lib/workspace/exec";

const TARGET_DIR = "/tmp/hive-terminal-paste";
const MAX_FILES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

export interface TerminalPasteAssetUpload {
  name: string;
  type: string;
  bytes: Uint8Array;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  if (files.length > MAX_FILES) throw new Error(`Paste up to ${MAX_FILES} images at once`);

  const client = await getCoderClientForUser(userId);
  const agentTarget = await client.getWorkspaceAgentName(workspaceId);
  const paths: string[] = [];
  const commands = [`umask 077`, `mkdir -p ${shellQuote(TARGET_DIR)}`];

  for (const file of files) {
    const extension = MIME_EXTENSIONS.get(file.type);
    if (!extension) throw new Error("Unsupported paste asset type");
    if (file.bytes.byteLength > MAX_BYTES) throw new Error("Pasted image is too large");

    const path = `${TARGET_DIR}/${randomUUID()}.${extension}`;
    paths.push(path);
    const encoded = Buffer.from(file.bytes).toString("base64");
    commands.push(
      `base64 -d > ${shellQuote(path)} <<'HIVE_TERMINAL_PASTE_ASSET'\n${encoded}\nHIVE_TERMINAL_PASTE_ASSET`,
    );
  }

  const result = await execInWorkspace(agentTarget, commands.join("\n"), {
    coderUrl: client.getBaseUrl(),
    sessionToken: client.getSessionToken(),
    timeoutMs: Math.max(DEFAULT_EXEC_TIMEOUT_MS, 120_000),
  });

  if (result.exitCode !== 0) {
    throw new Error("Failed to store pasted image in workspace");
  }

  return paths;
}
