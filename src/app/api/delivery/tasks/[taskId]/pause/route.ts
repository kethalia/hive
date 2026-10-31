import { getDb } from "@hive/db";
import { z } from "zod";
import { boundedSessionJson } from "@/lib/codex-session/route.server";
import { pauseRequestSchema } from "@/lib/delivery/contracts";
import {
  authorizeDeliveryRead,
  deliveryReadError,
  deliveryReadHeaders,
} from "@/lib/delivery/read-auth";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { DeliveryConflict } from "@/lib/delivery/state";

export const dynamic = "force-dynamic";
const bodySchema = pauseRequestSchema.omit({ taskId: true });

/** Changes scheduling only; never interrupts processes or clears writer holds. */
export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  if (process.env.HIVE_DELIVERY_ENABLED !== "true")
    return deliveryReadError("delivery_disabled", 404);
  const url = new URL(request.url);
  if (
    request.headers.get("origin") !== url.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return deliveryReadError("invalid_origin", 403);
  try {
    const session = await authorizeDeliveryRead(request);
    if (session instanceof Response) return session;
    const { taskId } = await context.params;
    if (url.search || !z.string().uuid().safeParse(taskId).success)
      return deliveryReadError("invalid_request", 400);
    let input: z.infer<typeof bodySchema>;
    try {
      input = bodySchema.parse(await boundedSessionJson(request, 2048));
    } catch {
      return deliveryReadError("invalid_request", 400);
    }
    const receipt = await new DeliveryRepository(getDb()).setPaused(session.user.id, {
      ...input,
      taskId,
    });
    return Response.json(receipt, { headers: deliveryReadHeaders });
  } catch (error) {
    if (error instanceof DeliveryConflict) {
      if (error.code === "task_not_found") return deliveryReadError("not_found", 404);
      if (["version_conflict", "event_replay_conflict"].includes(error.code))
        return deliveryReadError("task_changed", 409);
    }
    return deliveryReadError("delivery_unavailable", 503);
  }
}
