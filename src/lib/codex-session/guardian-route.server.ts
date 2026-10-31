import { ZodError } from "zod";
import { createGuardianService } from "./guardian-factory.server";
import type { GuardianService } from "./guardian-service.server";
import { RegistrationRejected } from "./registration-store.server";
import { boundedSessionJson } from "./route.server";

const response = (error: string, status: number) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
export async function guardianPost(
  request: Request,
  factory: (signal: AbortSignal) => Pick<GuardianService, "execute"> = (signal) =>
    createGuardianService({ signal }),
) {
  if (process.env.HIVE_GUARDIAN_ENABLED !== "true") return response("guardian_disabled", 404);
  if (request.method !== "POST") return response("invalid_method", 405);
  if (request.headers.has("origin")) return response("host_authentication_required", 403);
  const url = new URL(request.url);
  if (url.pathname !== "/api/codex-host/guardians" || request.url.includes("?") || url.hash)
    return response("invalid_request", 400);
  let value: unknown;
  try {
    value = await boundedSessionJson(request);
  } catch {
    return response("invalid_request", 400);
  }
  try {
    request.signal.throwIfAborted();
    const result = await factory(request.signal).execute(value);
    request.signal.throwIfAborted();
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ZodError) return response("invalid_request", 400);
    if (error instanceof RegistrationRejected) return response("host_authentication_required", 403);
    return response("guardian_unavailable", 503);
  }
}
