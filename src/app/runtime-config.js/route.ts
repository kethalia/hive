import { NextResponse } from "next/server";
import { getServerRuntimeConfig } from "@/lib/runtime-config";

export const dynamic = "force-dynamic";

export function GET() {
  const config = getServerRuntimeConfig();
  // Escape `<` so a value containing `</script>` cannot break out of an
  // inline-script consumer; also defensive for any future HTML embedding.
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const body = `window.__HIVE_CONFIG__=${json};`;
  return new NextResponse(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
