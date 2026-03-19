import { NextRequest, NextResponse } from "next/server";
import { createTask, listTasks } from "@/lib/api/tasks";

/**
 * POST /api/tasks — Create a new task.
 * Body: { prompt: string, repoUrl: string }
 * Returns: 201 with the created task JSON.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt, repoUrl } = body;

    if (!prompt || !repoUrl) {
      return NextResponse.json(
        { error: "Missing required fields: prompt, repoUrl" },
        { status: 400 }
      );
    }

    const task = await createTask({ prompt, repoUrl });
    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api] POST /api/tasks error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/tasks — List all tasks.
 * Returns: 200 with array of task objects.
 */
export async function GET() {
  try {
    const taskList = await listTasks();
    return NextResponse.json(taskList);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api] GET /api/tasks error: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
