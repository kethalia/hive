import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { publicationBody } from "@/lib/templates/publication-io";
import { claudeAccountRequestSchema, claudeAccountStatusSchema } from "./claude-account-contracts";
import { codexAccountRequestSchema, codexAccountStatusSchema } from "./codex-account-contracts";
import { createPortableAgentService } from "./portable-config.server";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function codexAccountRoute(request: Request, workspaceId: string) {
  return workspaceAccountRoute(request, workspaceId, "codex");
}
export async function claudeAccountRoute(request: Request, workspaceId: string) {
  return workspaceAccountRoute(request, workspaceId, "claude");
}
async function workspaceAccountRoute(
  request: Request,
  workspaceId: string,
  provider: "codex" | "claude",
) {
  if (
    (provider === "codex"
      ? process.env.HIVE_CODEX_ACCOUNTS_ENABLED
      : process.env.HIVE_CLAUDE_ACCOUNTS_ENABLED) !== "true"
  )
    return new Response(null, { status: 404, headers });
  const origin = process.env.HIVE_PUBLIC_ORIGIN;
  if (
    !origin ||
    new URL(origin).origin !== origin ||
    new URL(request.url).search ||
    request.method !== "POST" ||
    request.headers.get("Origin") !== origin ||
    request.headers.get("Sec-Fetch-Site") === "cross-site" ||
    request.headers.get("Content-Type") !== "application/json" ||
    request.headers.has("Content-Encoding")
  )
    return new Response(null, { status: 403, headers });
  if (!z.string().uuid().safeParse(workspaceId).success)
    return new Response(null, { status: 400, headers });
  const session = await getRequestSession();
  if (!session) return new Response(null, { status: 401, headers });
  try {
    const bytes = await publicationBody(
      new Response(request.body, { headers: request.headers }),
      provider === "codex" ? 1024 : 8192,
      AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
    );
    const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const principal = { hiveUserId: session.user.id, coderUserId: session.user.coderUserId };
    const service = createPortableAgentService();
    if (provider === "claude") {
      const result = await service.execute(
        principal,
        workspaceId,
        { operation: "claude-account", account: claudeAccountRequestSchema.parse(input) },
        request.signal,
      );
      return Response.json(claudeAccountStatusSchema.parse(result), { headers });
    }
    const result = await service.execute(
      principal,
      workspaceId,
      { operation: "codex-account", account: codexAccountRequestSchema.parse(input) },
      request.signal,
    );
    return Response.json(codexAccountStatusSchema.parse(result), { headers });
  } catch {
    // Unknown outcomes require status readback. Never claim cancel/logout from a
    // transport timeout, and never expose a provider response or credential path.
    return Response.json(
      { error: provider === "codex" ? "codex_account_unavailable" : "claude_account_unavailable" },
      { status: 409, headers },
    );
  }
}
