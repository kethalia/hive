import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { streamFromWorkspace } from "@/lib/workspace/stream";
import { workerWorkspaceName } from "@/lib/workspace/naming";

/**
 * SSE endpoint for streaming live agent output from a running workspace.
 *
 * GET /api/tasks/[id]/stream
 *
 * Lifecycle events are sent as named SSE events:
 *   - `event: status` data: {"status":"waiting"}   — no running workspace yet
 *   - `event: status` data: {"status":"connected"} — stream started
 *   - `data: <line>`                               — agent output line
 *   - `event: status` data: {"status":"ended"}     — stream finished
 *   - `event: error`  data: {"message":"..."}      — error occurred
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: taskId } = await params;

  // Validate taskId is a UUID before using it in any shell command
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(taskId)) {
    return new Response("Invalid task ID", { status: 400 });
  }

  console.log(`[stream] SSE connect: taskId=${taskId}`);

  const db = getDb();

  // Find the running worker workspace for this task
  let workspace;
  try {
    workspace = await db.workspace.findFirst({
      where: {
        taskId,
        templateType: "worker",
        status: "running",
      },
    });
  } catch (err) {
    console.log(
      `[stream] SSE error: taskId=${taskId} db lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    const errorStream = makeSSEStream((controller) => {
      controller.enqueue(
        formatSSE("error", JSON.stringify({ message: "Database lookup failed" })),
      );
      controller.close();
    });
    return sseResponse(errorStream);
  }

  if (!workspace) {
    console.log(`[stream] SSE waiting: taskId=${taskId} — no running workspace`);
    const waitingStream = makeSSEStream((controller) => {
      controller.enqueue(
        formatSSE("status", JSON.stringify({ status: "waiting" })),
      );
      controller.close();
    });
    return sseResponse(waitingStream);
  }

  // Derive workspace name from the shared naming convention
  const workspaceName = workerWorkspaceName(taskId);

  console.log(
    `[stream] SSE connected: taskId=${taskId} workspace=${workspaceName}`,
  );

  const { stdout, process: childProcess } = streamFromWorkspace(
    workspaceName,
    "tail -f -n +1 /tmp/hive-agent-output.log",
    request.signal,
  );

  const reader = stdout.getReader();

  const sseStream = makeSSEStream(async (controller) => {
    // Send connected status
    controller.enqueue(
      formatSSE("status", JSON.stringify({ status: "connected" })),
    );

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Sanitize: strip \r\n to prevent SSE control sequence injection
        const sanitized = value.replace(/[\r\n]/g, "");
        controller.enqueue(`data: ${sanitized}\n\n`);
      }
    } catch (err) {
      // Stream read error — typically from abort
      if (!request.signal.aborted) {
        console.log(
          `[stream] SSE relay error: taskId=${taskId} ${err instanceof Error ? err.message : String(err)}`,
        );
        controller.enqueue(
          formatSSE(
            "error",
            JSON.stringify({ message: "Stream relay failed" }),
          ),
        );
      }
    } finally {
      console.log(`[stream] SSE ended: taskId=${taskId}`);

      // Release reader lock before closing the controller
      try {
        reader.releaseLock();
      } catch {
        // Already released
      }

      try {
        controller.enqueue(
          formatSSE("status", JSON.stringify({ status: "ended" })),
        );
      } catch {
        // Controller may be closed already
      }
      try {
        controller.close();
      } catch {
        // Already closed
      }

      // Ensure child process is cleaned up
      if (!childProcess.killed) {
        childProcess.kill("SIGTERM");
      }
    }
  });

  return sseResponse(sseStream);
}

/** Format a named SSE event */
function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/** Create a ReadableStream from an async setup function */
function makeSSEStream(
  setup: (controller: ReadableStreamDefaultController<string>) => void | Promise<void>,
): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      await setup(controller);
    },
  });
}

/** Return a Response with SSE headers */
function sseResponse(stream: ReadableStream<string>): Response {
  const encoder = new TextEncoder();
  const encodedStream = stream.pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(chunk));
      },
    }),
  );

  return new Response(encodedStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
