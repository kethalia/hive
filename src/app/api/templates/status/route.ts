import { NextResponse } from "next/server";
import { compareTemplates } from "@/lib/templates/staleness";
import { KNOWN_TEMPLATES } from "@/lib/templates/staleness";

/**
 * GET /api/templates/status
 *
 * Returns staleness information for all known templates.
 * Calls compareTemplates which diffs local files against the active
 * remote version in Coder.
 */
export async function GET() {
  try {
    const statuses = await compareTemplates([...KNOWN_TEMPLATES]);
    return NextResponse.json(statuses);
  } catch (err) {
    console.error(`[api/templates/status] ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { error: "Failed to fetch template statuses" },
      { status: 500 }
    );
  }
}
