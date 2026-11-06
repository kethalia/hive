import { installedNativeReleaseRoute } from "@/lib/delivery/release-native-preview-route.server";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return installedNativeReleaseRoute(request, "reauthorize");
}
