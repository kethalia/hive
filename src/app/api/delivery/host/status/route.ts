import { deliveryStatusRoute } from "@/lib/delivery/status-route.server";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => deliveryStatusRoute(request);
