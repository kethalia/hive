import { getHivePublicOrigin } from "@hive/auth/hive-origin";
import { readAppPreviewCatalog } from "@/lib/app-preview-catalog.server";
import { hiveProductionOrigin } from "@/lib/app-preview-origin.mjs";
import { getRequestSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  if (
    getHivePublicOrigin() !== hiveProductionOrigin ||
    process.env.HIVE_NATIVE_MODE !== "production"
  )
    return Response.json({ error: "Preview catalog unavailable" }, { status: 404, headers });
  if (!(await getRequestSession()))
    return Response.json({ error: "Not authenticated" }, { status: 401, headers });
  try {
    return Response.json(await readAppPreviewCatalog(), { headers });
  } catch {
    return Response.json({ error: "Preview catalog unavailable" }, { status: 503, headers });
  }
}
