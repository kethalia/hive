import { getDb } from "@hive/db";
import { ZodError } from "zod";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { boundedSessionJson, sessionService } from "@/lib/codex-session/route.server";
import { DeliveryNativeSourceService } from "@/lib/delivery/native.server";
import { DeliveryConflict } from "@/lib/delivery/state";
export const dynamic = "force-dynamic";
const response = (error: string, status: number) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
export async function POST(request: Request) {
  if (
    process.env.HIVE_DELIVERY_NATIVE_ENABLED !== "true" ||
    process.env.HIVE_DELIVERY_MANAGER_ENABLED !== "true"
  )
    return response("native_observer_disabled", 404);
  if (request.headers.has("origin")) return response("host_authentication_required", 403);
  if (new URL(request.url).search) return response("invalid_request", 400);
  let value: unknown;
  try {
    value = await boundedSessionJson(request);
  } catch {
    return response("invalid_request", 400);
  }
  try {
    const sessions = sessionService();
    const service = new DeliveryNativeSourceService(getDb(), {
      reauthorize: (binding) => sessions.authority.reauthorize(binding),
    });
    return Response.json(await service.ingest(value), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ZodError) return response("invalid_request", 400);
    if (error instanceof RegistrationRejected) return response("host_authentication_required", 403);
    if (error instanceof DeliveryConflict) return response(error.code, 409);
    return response("native_observer_unavailable", 503);
  }
}
