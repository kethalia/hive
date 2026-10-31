import { sourceStateRoute } from "@/lib/delivery/source-state-route.server";
export const POST = (request: Request) => sourceStateRoute(request);
