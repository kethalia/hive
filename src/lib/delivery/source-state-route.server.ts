import { getDb } from "@hive/db";
import { ZodError } from "zod";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { boundedSessionJson, sessionService } from "@/lib/codex-session/route.server";
import { DeliverySourceStateService } from "./source-state.server";
import { DeliveryConflict } from "./state";

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
export async function sourceStateRoute(request: Request) {
  if (
    process.env.HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED !== "true" ||
    process.env.HIVE_DELIVERY_MANAGER_ENABLED !== "true"
  )
    return json({ error: "source_publication_disabled" }, 404);
  if (request.headers.has("origin")) return json({ error: "host_authentication_required" }, 403);
  if (new URL(request.url).search) return json({ error: "invalid_request" }, 400);
  let value: unknown;
  try {
    value = await boundedSessionJson(request, 16384);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  try {
    const sessions = sessionService();
    return json(
      await new DeliverySourceStateService(getDb(), {
        reauthorize: (binding) => sessions.authority.reauthorize(binding),
      }).read(value),
    );
  } catch (error) {
    if (error instanceof ZodError) return json({ error: "invalid_request" }, 400);
    if (error instanceof RegistrationRejected)
      return json({ error: "host_authentication_required" }, 403);
    if (error instanceof DeliveryConflict) return json({ error: error.code }, 409);
    return json({ error: "source_state_unavailable" }, 503);
  }
}
