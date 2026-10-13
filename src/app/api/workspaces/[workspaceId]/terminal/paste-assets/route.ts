import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { TERMINAL_PASTE_ASSET_MAX_TOTAL_BYTES } from "@/lib/terminal/paste-limits";
import { acquireTerminalPasteSlot } from "@/lib/workspace/paste-admission";
import {
  TERMINAL_PASTE_ASSET_MAX_BYTES,
  TERMINAL_PASTE_ASSET_MAX_FILES,
  uploadTerminalPasteAssets,
} from "@/lib/workspace/paste-assets";
import {
  PasteRequestError,
  readTerminalPasteFormData,
  TERMINAL_PASTE_REQUEST_TIMEOUT_MS,
} from "@/lib/workspace/paste-request";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const session = await getRequestSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { workspaceId } = await params;
  if (!workspaceId) {
    return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });
  }

  const release = acquireTerminalPasteSlot(session.user.id);
  if (!release) {
    void request.body?.cancel().catch(() => {});
    return NextResponse.json(
      { error: "Paste uploads are busy. Try again shortly." },
      { status: 429, headers: { "Retry-After": "2" } },
    );
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), TERMINAL_PASTE_REQUEST_TIMEOUT_MS);
  try {
    const formData = await readTerminalPasteFormData(request, signal);
    const files = formData.getAll("files");
    if (files.length === 0 || files.some((file) => !(file instanceof File))) {
      throw new PasteRequestError("No files provided", 400);
    }
    const uploadFiles = files.filter((file): file is File => file instanceof File);
    if (uploadFiles.length > TERMINAL_PASTE_ASSET_MAX_FILES) {
      throw new PasteRequestError(
        `Paste up to ${TERMINAL_PASTE_ASSET_MAX_FILES} files at once`,
        400,
      );
    }
    if (uploadFiles.some((file) => file.size > TERMINAL_PASTE_ASSET_MAX_BYTES)) {
      throw new PasteRequestError("Pasted file is too large", 413);
    }
    if (
      uploadFiles.reduce((total, file) => total + file.size, 0) >
      TERMINAL_PASTE_ASSET_MAX_TOTAL_BYTES
    ) {
      throw new PasteRequestError("Paste files must total 20 MiB or less", 413);
    }
    const paths = await uploadTerminalPasteAssets({
      userId: session.user.id,
      workspaceId,
      // Read only the file currently being transferred, rather than copying the whole batch.
      files: uploadFiles,
      signal,
    });
    signal.throwIfAborted();
    return NextResponse.json({ paths });
  } catch (error) {
    if (signal.aborted) {
      return NextResponse.json(
        { error: controller.signal.aborted ? "Paste upload timed out" : "Paste upload cancelled" },
        { status: controller.signal.aborted ? 504 : 408 },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to upload pasted file";
    return NextResponse.json(
      { error: message },
      {
        status: error instanceof PasteRequestError ? error.status : 400,
        ...(error instanceof PasteRequestError && error.status === 429
          ? { headers: { "Retry-After": "2" } }
          : {}),
      },
    );
  } finally {
    clearTimeout(timer);
    release();
  }
}
