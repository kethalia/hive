import { getHivePublicOrigin } from "@hive/auth/hive-origin";
import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { publicationBody } from "@/lib/templates/publication-io";
import {
  codexManagementRequestSchema,
  codexManagementResponseSchema,
} from "./codex-management-contracts";
import { AgentBridgeError } from "./portable-client.server";
import { createPortableAccountService } from "./portable-config.server";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const envelope = z
  .object({ buildId: z.string().uuid(), request: codexManagementRequestSchema })
  .strict();

export async function codexManagementRoute(request: Request, workspaceId: string) {
  if (process.env.HIVE_CODEX_ACCOUNTS_ENABLED !== "true")
    return new Response(null, { status: 404, headers });
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
      8192,
      AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
    );
    const input = envelope.parse(JSON.parse(new TextDecoder().decode(bytes)));
    const result = await createPortableAccountService("codex").execute(
      { hiveUserId: session.user.id, coderUserId: session.user.coderUserId },
      workspaceId,
      { operation: "codex-management", management: input.request },
      request.signal,
      input.buildId,
    );
    return Response.json(codexManagementResponseSchema.parse(result), { headers });
  } catch (error) {
    const unsupported = error instanceof AgentBridgeError && error.code === "unsupported";
    return Response.json(
      { error: unsupported ? "codex_management_update_required" : "codex_management_unavailable" },
      { status: unsupported ? 404 : 409, headers },
    );
  }
}
