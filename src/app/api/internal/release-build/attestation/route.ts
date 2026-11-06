import { installedReleaseBuildRoute } from "@/lib/delivery/release-build-route.server";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => installedReleaseBuildRoute(request, "attestation");
