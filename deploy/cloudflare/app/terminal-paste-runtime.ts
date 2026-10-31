import { randomUUID } from "node:crypto";
import {
  GenericTerminalFailure,
  genericTerminalIssuerSession,
} from "../../../src/lib/terminal/generic-auth.server";
import {
  TERMINAL_PASTE_ASSET_MAX_BYTES,
  TERMINAL_PASTE_ASSET_MAX_FILES,
  TERMINAL_PASTE_ASSET_MAX_TOTAL_BYTES,
} from "../../../src/lib/terminal/paste-limits";
import { acquireTerminalPasteSlot } from "../../../src/lib/workspace/paste-admission";
import {
  PasteRequestError,
  readTerminalPasteFormData,
} from "../../../src/lib/workspace/paste-request";
import {
  authorizeOwnedWorkspacePty,
  type GenericTerminalEnvironment,
} from "./generic-terminal-runtime";
import { transferTerminalPaste } from "./terminal-paste-transport";

export type TerminalPasteEnvironment = GenericTerminalEnvironment & {
  HIVE_TERMINAL_PASTE_ENABLED?: string;
};
// The existing 20MiB multipart contract needs a stricter Workers memory bound
// than the Node process's four-request admission. No waiting request queue.
let activePaste = false;
const suffixes: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "text/plain": "txt",
};
function name(file: File) {
  const source =
    file.name.trim() ||
    (suffixes[file.type] ? `clipboard.${suffixes[file.type]}` : "clipboard.bin");
  return `${randomUUID()}-${
    source
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "clipboard.bin"
  }`;
}
export function terminalPastePath(request: Request) {
  return /^\/api\/workspaces\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/terminal\/paste-assets$/.test(
    new URL(request.url).pathname,
  );
}
/** Ordinary clipboard data only. No host service, caller command/path or automatic retry. */
export async function terminalPasteRuntime(
  request: Request,
  env: TerminalPasteEnvironment,
  transportFetch: typeof fetch = fetch,
) {
  const response = (status: number, error: string) =>
    Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
  if (env.HIVE_TERMINAL_PASTE_ENABLED !== "true") return response(404, "Paste uploads unavailable");
  const url = new URL(request.url);
  if (
    !terminalPastePath(request) ||
    request.method !== "POST" ||
    url.search ||
    request.headers.has("Content-Encoding") ||
    request.headers.has("Authorization")
  )
    return response(400, "Paste request rejected");
  if (
    request.headers.get("Origin") !== url.origin ||
    url.origin !== env.HIVE_PREVIEW_ORIGIN ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    return response(403, "Origin rejected");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)]);
  let release: (() => void) | null = null;
  try {
    const session = await genericTerminalIssuerSession(request, env);
    if (!session) return response(401, "Not authenticated");
    if (activePaste) return response(429, "Paste uploads are busy. Try again shortly.");
    // Admission precedes multipart allocation. Capacity is per isolate, not global.
    release = acquireTerminalPasteSlot(session.session.sessionId);
    if (!release) return response(429, "Paste uploads are busy. Try again shortly.");
    activePaste = true;
    const workspaceId = url.pathname.split("/")[3];
    const initial = await authorizeOwnedWorkspacePty(
      session.session.sessionId,
      env,
      workspaceId,
      undefined,
      signal,
      transportFetch,
    );
    const form = await readTerminalPasteFormData(request, signal);
    const entries = [...form.entries()];
    if (
      !entries.length ||
      entries.length > TERMINAL_PASTE_ASSET_MAX_FILES ||
      entries.some(([key, value]) => key !== "files" || !(value instanceof File))
    )
      throw new PasteRequestError("Invalid pasted files", 400);
    const files = entries.map(([, file]) => file as File);
    if (
      files.some((file) => file.size > TERMINAL_PASTE_ASSET_MAX_BYTES) ||
      files.reduce((sum, file) => sum + file.size, 0) > TERMINAL_PASTE_ASSET_MAX_TOTAL_BYTES
    )
      throw new PasteRequestError("Pasted files are too large", 413);
    const uploads = [];
    for (const file of files) {
      signal.throwIfAborted();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
      uploads.push({ name: name(file), bytes, sha256 });
    }
    let checked = 0;
    const authorize = async () => {
      signal.throwIfAborted();
      if (initial.expiresAt <= Date.now()) throw new Error("expired");
      if (Date.now() - checked < 20000) return;
      const current = await authorizeOwnedWorkspacePty(
        session.session.sessionId,
        env,
        workspaceId,
        initial.agentId,
        signal,
        transportFetch,
      );
      if (
        current.userId !== initial.userId ||
        current.coderUserId !== initial.coderUserId ||
        current.buildId !== initial.buildId ||
        current.coderOrigin !== initial.coderOrigin
      )
        throw new Error("changed");
      checked = Date.now();
    };
    await authorize();
    const paths = await transferTerminalPaste({
      origin: initial.coderOrigin,
      agentId: initial.agentId,
      token: initial.token,
      files: uploads,
      signal,
      authorize,
      fetch: transportFetch,
    });
    return Response.json({ paths }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof GenericTerminalFailure)
      return response(
        error.closeCode === 4401 ? 401 : error.closeCode === 4403 ? 403 : 409,
        "Paste authorization unavailable",
      );
    if (signal.aborted)
      return response(
        request.signal.aborted ? 408 : 504,
        "Paste upload interrupted; remote state may be unknown",
      );
    if (error instanceof PasteRequestError) return response(error.status, error.message);
    return response(502, "Paste upload unavailable; do not retry an uncertain write automatically");
  } finally {
    if (release) {
      release();
      activePaste = false;
    }
  }
}
