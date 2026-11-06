import { createReadStream, existsSync, statSync } from "node:fs";
import type { Job, JobState } from "bullmq";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { SSE_POLL_INTERVAL_MS } from "@/lib/constants";
import {
  getTemplatePushQueue,
  pushLogPath,
  type TemplatePushJobData,
} from "@/lib/templates/push-queue";
import { KNOWN_TEMPLATES } from "@/lib/templates/staleness";

/** Regex allowing job IDs (UUID v4 format). */
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Queue completion can precede the worker's final asynchronous log writes. */
const TERMINAL_LOG_DRAIN_MS = 2000;

/**
 * Tail a template push's log as SSE data events, then emit its final status.
 * Queued and active jobs remain pending regardless of how long they take.
 * Queue state also supplies the result if the worker's local log is unavailable.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string; jobId: string }> },
) {
  const { name, jobId } = await params;
  const cookieStore = await cookies();
  const session = await getSession(cookieStore, request.headers.get("cookie"));
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(name)) {
    return new Response("Unknown template", { status: 400 });
  }
  if (!JOB_ID_RE.test(jobId)) return new Response("Invalid job ID", { status: 400 });

  let job: Job<TemplatePushJobData> | undefined;
  try {
    job = await getTemplatePushQueue().getJob(jobId);
  } catch {
    return new Response("Push queue unavailable", { status: 503 });
  }
  if (!job || job.data.userId !== session.user.id || job.data.templateName !== name) {
    return new Response("Push job not found", { status: 404 });
  }

  const logPath = pushLogPath(jobId);
  const pushJob = job;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let byteOffset = 0;
      let buffer = "";
      let terminalLogSince: number | null = null;

      function send(raw: string) {
        if (cancelled || request.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(raw));
        } catch {
          cancelled = true;
        }
      }
      function sendStatus(success: boolean, error?: string) {
        send(
          `event: status\ndata: ${JSON.stringify({ success, ...(error ? { error } : {}) })}\n\n`,
        );
      }
      function sendData(line: string) {
        // Prevent frame injection while preserving blank output lines.
        send(`data: ${line.replace(/[\r\n]/g, "")}\n\n`);
      }
      function processChunk(chunk: string): boolean {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "[exit:0]" || line === "[exit:1]") {
            sendStatus(line === "[exit:0]");
            return true;
          }
          sendData(line);
        }
        return false;
      }

      try {
        while (!cancelled && !request.signal.aborted) {
          // Keep proxies from timing out while earlier jobs occupy the workers.
          send(": waiting for template push\n\n");
          let state: JobState | "unknown" | undefined;
          try {
            state = await pushJob.getState();
          } catch {
            // A queue lookup failure does not mean the push failed. Keep its
            // controls disabled and retry rather than enabling a duplicate push.
          }
          if (cancelled || request.signal.aborted) return;
          let localLogReadable = false;
          if (existsSync(logPath)) {
            try {
              const size = statSync(logPath).size;
              if (size > byteOffset) {
                let content = "";
                const reader = createReadStream(logPath, {
                  encoding: "utf-8",
                  start: byteOffset,
                  end: size - 1,
                });
                for await (const chunk of reader) content += chunk.toString();
                byteOffset = size;
                if (processChunk(content)) return;
              }
              localLogReadable = true;
            } catch {
              // Log files are local to the worker. Their absence/read failure
              // cannot decide whether a queued or running job has failed.
            }
          }
          if (state === "completed" || state === "failed" || state === "unknown") {
            terminalLogSince ??= Date.now();
            // Let a readable local log reach its sentinel before falling back
            // to queue state. Missing/unreadable worker-local logs need no wait.
            if (
              !localLogReadable ||
              state === "unknown" ||
              Date.now() - terminalLogSince >= TERMINAL_LOG_DRAIN_MS
            ) {
              if (buffer) sendData(buffer);
              sendStatus(
                state === "completed",
                state === "failed"
                  ? "Template push failed"
                  : state === "unknown"
                    ? "Push job no longer exists"
                    : undefined,
              );
              return;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Reader cancellation already closed the controller.
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
