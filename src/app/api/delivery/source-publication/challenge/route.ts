import { sourcePublicationRoute } from "@/lib/delivery/source-transport-route.server";
export const POST = (request: Request) => sourcePublicationRoute(request, "challenge");
