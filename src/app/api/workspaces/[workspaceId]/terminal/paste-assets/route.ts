import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { uploadTerminalPasteAssets } from "@/lib/workspace/paste-assets";

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
    return NextResponse.json({ error: "No image files provided" }, { status: 400 });
  }
  const imageFiles = files.filter((file): file is File => file instanceof File);

  try {
    const paths = await uploadTerminalPasteAssets({
      userId: session.user.id,
      workspaceId,
      files: await Promise.all(
        imageFiles.map(async (file) => ({
          name: file.name,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        })),
      ),
    });
    return NextResponse.json({ paths });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload pasted image";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
