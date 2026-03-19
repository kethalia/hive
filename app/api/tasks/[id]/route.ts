import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/api/tasks";

/**
 * GET /api/tasks/[id] — Get a single task by ID.
 * Returns: 200 with task JSON (including workspaces + logs) or 404.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const task = await getTask(id);

    if (!task) {
      return NextResponse.json(
        { error: "Task not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(task);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api] GET /api/tasks/[id] error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
