import { NextRequest } from "next/server";
import { createReadStream, existsSync } from "fs";
import { pushLogPath } from "@/lib/templates/push-queue";
import { KNOWN_TEMPLATES } from "@/lib/templates/staleness";

/** Regex allowing job IDs (UUID v4 format). */
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/templates/[name]/push/[jobId]/stream
 *
 * SSE endpoint that tails the push log file for the given job.
 * Emits lines as `data:` events, and emits a named `status` event
 * when it detects the `[exit:0]` or `[exit:1]` sentinel.
 *
 * SSE events:
 *   - `data: <line>` — log output
 *   - `event: status\ndata: {"success":true}`  — push succeeded
 *   - `event: status\ndata: {"success":false}` — push failed
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string; jobId: string }> }
) {
  const { name, jobId } = await params;

  // Validate inputs
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(name)) {
    return new Response("Unknown template", { status: 400 });
  }

  if (!JOB_ID_RE.test(jobId)) {
    return new Response("Invalid job ID", { status: 400 });
  }

  const logPath = pushLogPath(jobId);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      /** Enqueue a raw SSE string. */
      function send(raw: string) {
        try {
          controller.enqueue(encoder.encode(raw));
        } catch {
          // Controller may be closed if client disconnected
        }
      }

      /** Emit a named SSE event. */
      function sendEvent(event: string, data: string) {
        send(`event: ${event}\ndata: ${data}\n\n`);
      }

      /** Emit a data-only SSE line. */
      function sendData(line: string) {
        // Sanitize: strip CR/LF to prevent SSE injection
        const sanitized = line.replace(/[\r\n]/g, "");
        if (sanitized.length > 0) {
          send(`data: ${sanitized}\n\n`);
        }
      }

      // Wait up to 30s for the log file to appear (job may not have started yet)
      const startWait = Date.now();
      while (!existsSync(logPath)) {
        if (request.signal.aborted) {
          controller.close();
          return;
        }
        if (Date.now() - startWait > 30_000) {
          sendEvent("status", JSON.stringify({ success: false, error: "Log file never appeared" }));
          controller.close();
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // Tail the log file line by line, checking for the exit sentinel
      await new Promise<void>((resolve) => {
        let buffer = "";
        let finished = false;

        const fileStream = createReadStream(logPath, { encoding: "utf-8" });

        fileStream.on("data", (chunk: string | Buffer) => {
          buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
          const lines = buffer.split("\n");
          // Keep the last (possibly incomplete) segment in the buffer
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line === "[exit:0]") {
              finished = true;
              sendEvent("status", JSON.stringify({ success: true }));
            } else if (line === "[exit:1]") {
              finished = true;
              sendEvent("status", JSON.stringify({ success: false }));
            } else {
              sendData(line);
            }
          }
        });

        fileStream.on("end", () => {
          // Flush remaining buffer
          if (buffer.length > 0) {
            if (buffer === "[exit:0]") {
              sendEvent("status", JSON.stringify({ success: true }));
            } else if (buffer === "[exit:1]") {
              sendEvent("status", JSON.stringify({ success: false }));
            } else {
              sendData(buffer);
            }
            buffer = "";
          }

          if (!finished) {
            // File ended without sentinel — log may still be written by the worker
            // Poll for updates by re-reading after a short delay
            let pollCount = 0;
            const MAX_POLLS = 120; // 60s total

            const poll = () => {
              if (request.signal.aborted || finished || pollCount >= MAX_POLLS) {
                if (!finished) {
                  sendEvent("status", JSON.stringify({ success: false, error: "Timed out waiting for completion" }));
                }
                resolve();
                return;
              }
              pollCount++;
              setTimeout(() => {
                const tailStream = createReadStream(logPath, {
                  encoding: "utf-8",
                  start: 0,
                });
                let content = "";
                tailStream.on("data", (c: string | Buffer) => {
                  content += typeof c === "string" ? c : c.toString("utf-8");
                });
                tailStream.on("end", () => {
                  const allLines = content.split("\n");
                  for (const line of allLines) {
                    if (line === "[exit:0]") {
                      finished = true;
                      sendEvent("status", JSON.stringify({ success: true }));
                      break;
                    } else if (line === "[exit:1]") {
                      finished = true;
                      sendEvent("status", JSON.stringify({ success: false }));
                      break;
                    }
                  }
                  if (finished) {
                    resolve();
                  } else {
                    poll();
                  }
                });
                tailStream.on("error", () => poll());
              }, 500);
            };
            poll();
          } else {
            resolve();
          }
        });

        fileStream.on("error", (err) => {
          sendEvent("status", JSON.stringify({ success: false, error: err.message }));
          resolve();
        });

        // Abort handling
        request.signal.addEventListener("abort", () => {
          fileStream.destroy();
          resolve();
        });
      });

      try {
        controller.close();
      } catch {
        // Already closed
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
