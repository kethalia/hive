import { NextResponse } from "next/server";
import { APP_VERSION } from "@/lib/app-version";
import { getRequestSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getRequestSession();
  const headers = { "Cache-Control": "no-store, max-age=0" };
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401, headers });
  }
  return NextResponse.json(APP_VERSION, { headers });
}
