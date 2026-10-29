import { getDb } from "@hive/db";
import { z } from "zod";
import {
  authorizeDeliveryRead,
  deliveryReadError,
  deliveryReadHeaders,
} from "@/lib/delivery/read-auth";
import { listDeliveryTasks } from "@/lib/delivery/reads";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const session = await authorizeDeliveryRead(request);
  if (session instanceof Response) return session;
  const query = new URL(request.url).searchParams;
  const cursor = query.get("cursor");
  if (
    [...query.keys()].some((key) => key !== "cursor") ||
    query.getAll("cursor").length > 1 ||
    (cursor !== null && !z.string().uuid().safeParse(cursor).success)
  )
    return deliveryReadError("invalid_request", 400);
  try {
    const result = await listDeliveryTasks(getDb(), session.user.id, cursor ?? undefined);
    return result
      ? Response.json(result, { headers: deliveryReadHeaders })
      : deliveryReadError("not_found", 404);
  } catch {
    return deliveryReadError("delivery_unavailable", 503);
  }
}
