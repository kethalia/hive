import { codexAccountRoute } from "@/lib/agents/codex-account-route.server";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  return codexAccountRoute(request, (await context.params).workspaceId);
}
