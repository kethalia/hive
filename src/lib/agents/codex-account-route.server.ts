import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { publicationBody } from "@/lib/templates/publication-io";
import { codexAccountRequestSchema, codexAccountStatusSchema } from "./codex-account-contracts";
import { createPortableAgentService } from "./portable-config.server";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function codexAccountRoute(request: Request, workspaceId: string) {
  if (process.env.HIVE_CODEX_ACCOUNTS_ENABLED !== "true")
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
      1024,
      AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
    );
    const account = codexAccountRequestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    const result = await createPortableAgentService().execute(
      { hiveUserId: session.user.id, coderUserId: session.user.coderUserId },
      workspaceId,
      { operation: "codex-account", account },
      request.signal,
    );
    return Response.json(codexAccountStatusSchema.parse(result), { headers });
  } catch {
    // Unknown outcomes require status readback. Never claim cancel/logout from a
    // transport timeout, and never expose a provider response or credential path.
    return Response.json({ error: "codex_account_unavailable" }, { status: 409, headers });
  }
}
