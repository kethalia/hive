import type { NextRequest } from "next/server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string; jobId: string }> },
) {
  if (process.env.HIVE_RUNTIME_TARGET !== "cloudflare") {
    const legacy = await import("@/lib/templates/push-stream-route.node");
    return legacy.GET(request, context);
  }
  const { cloudflareTemplatePublicationRoutes } = await import(
    "@/lib/templates/publication-factory"
  );
  const { name, jobId } = await context.params;
  return cloudflareTemplatePublicationRoutes().stream(request, name, jobId);
}
