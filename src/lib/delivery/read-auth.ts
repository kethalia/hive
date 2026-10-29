import { getRequestSession } from "@/lib/auth/session";
export const deliveryReadHeaders = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export function deliveryReadError(error: string, status: number) {
  return Response.json({ error }, { status, headers: deliveryReadHeaders });
}
export async function authorizeDeliveryRead(request: Request) {
  if (process.env.HIVE_DELIVERY_ENABLED !== "true")
    return deliveryReadError("delivery_disabled", 404);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return deliveryReadError("invalid_origin", 403);
  const session = await getRequestSession();
  return session ?? deliveryReadError("not_authenticated", 401);
}
