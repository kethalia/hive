import { z } from "zod";
import { createGuardianService } from "@/lib/codex-session/guardian-factory.server";
import {
  authorizeSessionOwner,
  boundedSessionJson,
  sessionError,
  sessionResponseHeaders,
} from "@/lib/codex-session/route.server";

export const dynamic = "force-dynamic";
const inputSchema = z
  .object({ workspaceId: z.string().uuid(), runtimeId: z.string().uuid() })
  .strict();

/** Owner-initiated recovery; successful response does not claim tree exit. */
export async function POST(request: Request) {
  if (process.env.HIVE_GUARDIAN_ENABLED !== "true") return sessionError("guardian_disabled", 404);
  try {
    const session = await authorizeSessionOwner(request);
    if (session instanceof Response) return session;
    if (new URL(request.url).search) return sessionError("invalid_request", 400);
    const parsed = inputSchema.safeParse(await boundedSessionJson(request, 4096));
    if (!parsed.success) return sessionError("invalid_request", 400);
    const result = await createGuardianService({ signal: request.signal }).recoverExpiredEmpty(
      { hiveUserId: session.user.id, coderUserId: session.user.coderUserId },
      parsed.data.workspaceId,
      parsed.data.runtimeId,
    );
    return Response.json(result, { headers: sessionResponseHeaders });
  } catch {
    return sessionError("guardian_recovery_unavailable", 503);
  }
}
