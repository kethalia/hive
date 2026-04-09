import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getTemplatePushQueue } from "@/lib/templates/push-queue";
import { KNOWN_TEMPLATES } from "@/lib/templates/staleness";

/**
 * POST /api/templates/[name]/push
 *
 * Enqueues a template push job for the given template name.
 * Returns the jobId so the client can open the SSE stream.
 *
 * Rejects unknown template names with 400.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  // Validate name against known templates
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(name)) {
    return NextResponse.json(
      { error: `Unknown template: "${name}". Known: ${KNOWN_TEMPLATES.join(", ")}` },
      { status: 400 }
    );
  }

  const jobId = randomUUID();

  try {
    const queue = getTemplatePushQueue();
    await queue.add(
      `push-${name}`,
      { templateName: name, jobId },
      { jobId }
    );
  } catch (err) {
    console.error(`[api/templates/push] Failed to enqueue job for "${name}": ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { error: "Failed to enqueue push job" },
      { status: 500 }
    );
  }

  console.log(`[api/templates/push] Enqueued job ${jobId} for template "${name}"`);
  return NextResponse.json({ jobId });
}
