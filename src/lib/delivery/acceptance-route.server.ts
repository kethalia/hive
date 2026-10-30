import { getDb } from "@hive/db";
import { ZodError } from "zod";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { boundedSessionJson, sessionService } from "@/lib/codex-session/route.server";
import { acceptanceServices } from "./acceptance-factory.server";
import { DeliveryAcceptanceService } from "./acceptance-service.server";
import { DeliveryConflict } from "./state";

const reply = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "Cache-Control": "private, no-store" } });
export async function acceptanceRoute(request: Request) {
  if (process.env.HIVE_DELIVERY_ACCEPTANCE_ENABLED !== "true")
    return reply({ error: "acceptance_disabled" }, 404);
  if (request.headers.has("origin")) return reply({ error: "host_authentication_required" }, 403);
  if (new URL(request.url).search) return reply({ error: "invalid_request" }, 400);
  let value: unknown;
  try {
    value = await boundedSessionJson(request, 262144);
  } catch {
    return reply({ error: "invalid_request" }, 400);
  }
  try {
    const db = getDb(),
      services = acceptanceServices(db);
    if (!services) throw Error("disabled");
    const sessions = sessionService();
    return reply(
      await new DeliveryAcceptanceService(db, services.store, {
        policies: services.policies,
        reauthorize: (b) => sessions.authority.reauthorize(b),
        prepareReview: (tx, host, candidate) =>
          services.material.prepare(
            tx,
            services.store,
            host.binding.ownerId,
            host.binding.id,
            candidate,
          ),
      }).dispatch(value),
    );
  } catch (error) {
    if (error instanceof ZodError) return reply({ error: "invalid_request" }, 400);
    if (error instanceof RegistrationRejected)
      return reply({ error: "host_authentication_required" }, 403);
    if (error instanceof DeliveryConflict) return reply({ error: error.code }, 409);
    return reply({ error: "acceptance_unavailable" }, 503);
  }
}
