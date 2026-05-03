import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { compareTemplates, KNOWN_TEMPLATES } from "@/lib/templates/staleness";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const session = await getSession(cookieStore);
    if (!session) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const statuses = await compareTemplates([...KNOWN_TEMPLATES], session.user.id);
    return NextResponse.json(statuses);
  } catch (err) {
    console.error(`[api/templates/status] ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "Failed to fetch template statuses" }, { status: 500 });
  }
}
