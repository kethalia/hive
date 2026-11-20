import { getHivePublicOrigin } from "@hive/auth/hive-origin";
import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { publicationBody } from "@/lib/templates/publication-io";
import { claudeAccountRequestSchema, claudeAccountStatusSchema } from "./claude-account-contracts";
import { codexAccountRequestSchema, codexAccountStatusSchema } from "./codex-account-contracts";
import { createPortableAccountService } from "./portable-config.server";
import { WorkspaceAppSetupError } from "./workspace-app-binding.server";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const codexEnvelope = z
  .object({ buildId: z.string().uuid(), request: codexAccountRequestSchema })
  .strict();
const claudeEnvelope = z
  .object({ buildId: z.string().uuid(), request: claudeAccountRequestSchema })
  .strict();

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
  const flag =
    provider === "codex"
      ? process.env.HIVE_CODEX_ACCOUNTS_ENABLED
      : process.env.HIVE_CLAUDE_ACCOUNTS_ENABLED;
  if (flag !== "true") return new Response(null, { status: 404, headers });
  const origin = getHivePublicOrigin();
  const target = new URL(request.url);
  if (
    !origin ||
    target.origin !== origin ||
    target.search ||
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
  if (!session) return Response.json({ error: "not_authenticated" }, { status: 401, headers });
  try {
    const bytes = await publicationBody(
      new Response(request.body, { headers: request.headers }),
      provider === "codex" ? 1024 : 8192,
      AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
    );
    const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const principal = { hiveUserId: session.user.id, coderUserId: session.user.coderUserId };
    const service = createPortableAccountService(provider);
    if (provider === "claude") {
      const action = claudeEnvelope.parse(input);
      const result = await service.execute(
        principal,
        workspaceId,
        { operation: "claude-account", account: action.request },
        request.signal,
        action.buildId,
      );
      return Response.json(claudeAccountStatusSchema.parse(result), { headers });
    }
    const action = codexEnvelope.parse(input);
    const result = await service.execute(
      principal,
      workspaceId,
      { operation: "codex-account", account: action.request },
      request.signal,
      action.buildId,
    );
    return Response.json(codexAccountStatusSchema.parse(result), { headers });
  } catch (error) {
    if (error instanceof WorkspaceAppSetupError)
      return Response.json({ error: error.reason }, { status: 409, headers });
    // A timed-out mutation requires status readback, never automatic replay.
    return Response.json(
      { error: provider === "codex" ? "codex_account_unavailable" : "claude_account_unavailable" },
      { status: 409, headers },
    );
  }
}
