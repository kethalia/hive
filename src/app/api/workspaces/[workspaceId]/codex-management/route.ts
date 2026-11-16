import { codexManagementRoute } from "@/lib/agents/codex-management-route.server";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  return codexManagementRoute(request, (await context.params).workspaceId);
}
