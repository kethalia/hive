import { codexAccountRoute } from "@/lib/agents/codex-account-route.server";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return codexAccountRoute(request, (await context.params).id);
}
