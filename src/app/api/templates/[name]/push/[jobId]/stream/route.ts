import type { NextRequest } from "next/server";
import { cloudflareTemplatePublicationRoutes } from "@/lib/templates/publication-factory";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ name: string; jobId: string }> },
) {
  if (process.env.HIVE_RUNTIME_TARGET !== "cloudflare") {
    const node = await import("@/lib/templates/push-stream-route.node");
    return node.GET(request, context);
  }
  const { name, jobId } = await context.params;
  return cloudflareTemplatePublicationRoutes().stream(request, name, jobId);
}
