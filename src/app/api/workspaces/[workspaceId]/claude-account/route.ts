import { claudeAccountRoute } from "@/lib/agents/codex-account-route.server";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  return claudeAccountRoute(request, (await context.params).workspaceId);
}
