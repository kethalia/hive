import { getDb } from "@hive/db";
import { z } from "zod";
import {
  authorizeDeliveryRead,
  deliveryReadError,
  deliveryReadHeaders,
} from "@/lib/delivery/read-auth";
import { readDeliveryTask } from "@/lib/delivery/reads";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const session = await authorizeDeliveryRead(request);
  if (session instanceof Response) return session;
  const { taskId } = await context.params;
  const query = new URL(request.url).searchParams;
  const reportId = query.get("report");
  if (
    !z.string().uuid().safeParse(taskId).success ||
    [...query.keys()].some((key) => key !== "report") ||
    query.getAll("report").length > 1 ||
    (reportId !== null && !z.string().uuid().safeParse(reportId).success)
  )
    return deliveryReadError("invalid_request", 400);
  try {
    const task = await readDeliveryTask(getDb(), session.user.id, taskId, reportId ?? undefined);
    return task
      ? Response.json(task, { headers: deliveryReadHeaders })
      : deliveryReadError("not_found", 404);
  } catch {
    return deliveryReadError("delivery_unavailable", 503);
  }
}
