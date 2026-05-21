import { NextResponse } from "next/server";
import { getServerRuntimeConfig } from "@/lib/runtime-config";

export const dynamic = "force-dynamic";

export function GET() {
  const config = getServerRuntimeConfig();
  // Escape `<` so a value containing `</script>` cannot break out of an
  // inline-script consumer; also escape U+2028/U+2029 which are valid in JSON
  // strings but break JavaScript parsers.
  const json = JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const body = `window.__HIVE_CONFIG__=${json};`;
  return new NextResponse(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
