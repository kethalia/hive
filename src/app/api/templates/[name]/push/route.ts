import type { NextRequest } from "next/server";
import { cloudflareTemplatePublicationRoutes } from "@/lib/templates/publication-factory";

export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  if (process.env.HIVE_RUNTIME_TARGET !== "cloudflare") {
    const node = await import("@/lib/templates/push-route.node");
    return node.POST(request, context);
  }
  const { name } = await context.params;
  return cloudflareTemplatePublicationRoutes().push(request, name);
}
