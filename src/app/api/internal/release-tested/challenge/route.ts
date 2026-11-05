import { installedReleaseTestRoute } from "@/lib/delivery/release-tested-route.server";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => installedReleaseTestRoute(request, "challenge");
