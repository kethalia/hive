import { NextResponse } from "next/server";
import { getServerRuntimeConfig, serializeRuntimeConfigScript } from "@/lib/runtime-config";

export const dynamic = "force-dynamic";

export function GET() {
  const config = getServerRuntimeConfig();
  const body = serializeRuntimeConfigScript(config);
  return new NextResponse(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
