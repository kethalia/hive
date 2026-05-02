import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getTemplatePushQueue } from "@/lib/templates/push-queue";
import { KNOWN_TEMPLATES } from "@/lib/templates/staleness";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const cookieStore = await cookies();
  const session = await getSession(cookieStore);
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { name } = await params;

  if (!(KNOWN_TEMPLATES as readonly string[]).includes(name)) {
    return NextResponse.json(
      { error: `Unknown template: "${name}". Known: ${KNOWN_TEMPLATES.join(", ")}` },
      { status: 400 },
    );
  }

  const jobId = randomUUID();

  try {
    const queue = getTemplatePushQueue();
    await queue.add(
      `push-${name}`,
      { templateName: name, jobId, userId: session.user.id },
      { jobId },
    );
  } catch (err) {
    console.error(
      `[api/templates/push] Failed to enqueue job for "${name}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: "Failed to enqueue push job" }, { status: 500 });
  }

  console.log(`[api/templates/push] Enqueued job ${jobId} for template "${name}"`);
  return NextResponse.json({ jobId });
}
