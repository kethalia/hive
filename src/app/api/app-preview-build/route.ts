import { getHivePublicOrigin } from "@hive/auth/hive-origin";
import { appPreviewBuildSchema } from "@/lib/app-preview-catalog";
import { appPreviewBranchSlug, appPreviewOrigin } from "@/lib/app-preview-origin.mjs";

export const dynamic = "force-dynamic";

// Publish only the public Git branch and commit verified by Workers Builds.
export function GET() {
  const build = appPreviewBuildSchema.safeParse({
    branch: process.env.HIVE_PROVIDER_BUILD_BRANCH,
    revision: process.env.HIVE_PROVIDER_BUILD_SHA,
  });
  const headers = { "Cache-Control": "no-store" };
  if (
    process.env.HIVE_NATIVE_MODE !== "preview" ||
    !build.success ||
    appPreviewOrigin(appPreviewBranchSlug(build.data.branch)) !== getHivePublicOrigin()
  ) {
    return Response.json({ error: "Preview build unavailable" }, { status: 404, headers });
  }
  return Response.json(build.data, { headers });
}
