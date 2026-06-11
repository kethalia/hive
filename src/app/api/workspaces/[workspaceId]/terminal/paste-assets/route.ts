import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import {
  TERMINAL_PASTE_ASSET_MAX_BYTES,
  TERMINAL_PASTE_ASSET_MAX_FILES,
  uploadTerminalPasteAssets,
} from "@/lib/workspace/paste-assets";

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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const files = formData.getAll("files");
  if (files.length === 0 || files.some((file) => !(file instanceof File))) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }
  const uploadFiles = files.filter((file): file is File => file instanceof File);
  if (uploadFiles.length > TERMINAL_PASTE_ASSET_MAX_FILES) {
    return NextResponse.json(
      { error: `Paste up to ${TERMINAL_PASTE_ASSET_MAX_FILES} files at once` },
      { status: 400 },
    );
  }
  if (uploadFiles.some((file) => file.size > TERMINAL_PASTE_ASSET_MAX_BYTES)) {
    return NextResponse.json({ error: "Pasted file is too large" }, { status: 400 });
  }

  try {
    const paths = await uploadTerminalPasteAssets({
      userId: session.user.id,
      workspaceId,
      files: await Promise.all(
        uploadFiles.map(async (file) => ({
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      ),
    });
    return NextResponse.json({ paths });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload pasted file";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
