import { getHivePublicOrigin } from "@hive/auth/hive-origin";
import { readAppPreviewCandidates } from "@/lib/app-preview-catalog.server";
import { hiveProductionOrigin } from "@/lib/app-preview-origin.mjs";
import { getRequestSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  if (
    getHivePublicOrigin() !== hiveProductionOrigin ||
    process.env.HIVE_NATIVE_MODE !== "production"
  )
    return Response.json({ error: "Preview catalog unavailable" }, { status: 404, headers });
  if (!(await getRequestSession()))
    return Response.json({ error: "Not authenticated" }, { status: 401, headers });
  // Older installed bundles expect verified entries and cannot check candidates.
  if (new URL(request.url).searchParams.get("view") !== "candidates") {
    return Response.json([], { headers });
  }
  try {
    return Response.json(await readAppPreviewCandidates(), { headers });
  } catch {
    return Response.json({ error: "Preview catalog unavailable" }, { status: 503, headers });
  }
}
