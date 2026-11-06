import type { NextRequest } from "next/server";

export async function POST(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  if (process.env.HIVE_RUNTIME_TARGET !== "cloudflare") {
    const legacy = await import("@/lib/templates/push-route.node");
    return legacy.POST(request, context);
  }
  const { cloudflareTemplatePublicationRoutes } = await import(
    "@/lib/templates/publication-factory"
  );
  const { name } = await context.params;
  return cloudflareTemplatePublicationRoutes().push(request, name);
}
