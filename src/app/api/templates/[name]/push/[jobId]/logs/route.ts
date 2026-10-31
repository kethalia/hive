import { cloudflareTemplatePublicationLogRoute } from "@/lib/templates/publication-log-factory";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string; jobId: string }> },
) {
  if (process.env.HIVE_RUNTIME_TARGET !== "cloudflare")
    return Response.json(
      { error: "logs_disabled" },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  const { name, jobId } = await params;
  return cloudflareTemplatePublicationLogRoute()(request, name, jobId);
}
