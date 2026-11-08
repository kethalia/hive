import { z } from "zod";
import {
  accountMaintenanceRequestSchema,
  accountMaintenanceViewSchema,
} from "@/lib/codex-session/account-maintenance-contracts";
import { createGuardianService } from "@/lib/codex-session/guardian-factory.server";
import {
  authorizeSessionOwner,
  boundedSessionJson,
  sessionError,
  sessionResponseHeaders,
} from "@/lib/codex-session/route.server";

export const dynamic = "force-dynamic";
/** Explicit owner intent only. The model and host operation envelopes cannot
 * manufacture a maintenance request or owner resume-intent receipt. */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  if (
    process.env.HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED !== "true" ||
    process.env.HIVE_GUARDIAN_ENABLED !== "true"
  )
    return sessionError("account_maintenance_disabled", 404);
  try {
    const session = await authorizeSessionOwner(request);
    if (session instanceof Response) return session;
    const { workspaceId } = await context.params;
    if (!z.string().uuid().safeParse(workspaceId).success || new URL(request.url).search)
      return sessionError("invalid_request", 400);
    const parsed = accountMaintenanceRequestSchema.safeParse(
      await boundedSessionJson(request, 4096),
    );
    if (!parsed.success) return sessionError("invalid_request", 400);
    const result = await createGuardianService({
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)]),
    }).accountMaintenance(
      { hiveUserId: session.user.id, coderUserId: session.user.coderUserId },
      workspaceId,
      parsed.data,
    );
    if (request.signal.aborted) throw Error("account_maintenance_unavailable");
    return Response.json(accountMaintenanceViewSchema.parse(result), {
      headers: sessionResponseHeaders,
    });
  } catch {
    return sessionError("account_maintenance_unavailable", 409);
  }
}
