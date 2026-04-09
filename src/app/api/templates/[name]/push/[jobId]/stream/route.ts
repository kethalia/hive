import { NextRequest } from "next/server";
import { existsSync, statSync, createReadStream } from "fs";
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
 *   - `data: <line>` — log output (blank lines emitted as `data: `)
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

      /**
       * Emit a data-only SSE line.
       * Blank lines are emitted as `data: ` (empty value) so the terminal
       * renders them correctly — stripping them breaks CLI output readability.
       */
      function sendData(line: string) {
        // Only strip CR/LF to prevent SSE frame injection; preserve blank lines
        const sanitized = line.replace(/[\r\n]/g, "");
        send(`data: ${sanitized}\n\n`);
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

      // Tail the log file using a byte offset so each poll only reads new content.
      // This avoids the O(n²) re-read-from-zero pattern — critical for large logs.
      await new Promise<void>((resolve) => {
        let byteOffset = 0;
        let buffer = "";
        let finished = false;
        let pollCount = 0;
        const MAX_POLLS = 240; // 120s total at 500ms intervals

        function processChunk(chunk: string) {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line === "[exit:0]") {
              finished = true;
              sendEvent("status", JSON.stringify({ success: true }));
              return;
            } else if (line === "[exit:1]") {
              finished = true;
              sendEvent("status", JSON.stringify({ success: false }));
              return;
            } else {
              sendData(line);
            }
          }
        }

        function poll() {
          if (request.signal.aborted || finished) {
            if (!finished && request.signal.aborted) {
              // Client disconnected — no need to emit status
            }
            resolve();
            return;
          }

          if (pollCount >= MAX_POLLS) {
            sendEvent("status", JSON.stringify({ success: false, error: "Timed out waiting for completion" }));
            resolve();
            return;
          }

          pollCount++;

          // Only read bytes written since the last poll
          let currentSize = byteOffset;
          try {
            currentSize = statSync(logPath).size;
          } catch {
            // File may have been cleaned up — stop polling
            if (!finished) {
              sendEvent("status", JSON.stringify({ success: false, error: "Log file disappeared" }));
            }
            resolve();
            return;
          }

          if (currentSize <= byteOffset) {
            // No new bytes — check again after delay
            setTimeout(poll, 500);
            return;
          }

          const readStream = createReadStream(logPath, {
            encoding: "utf-8",
            start: byteOffset,
            end: currentSize - 1,
          });

          let newContent = "";
          readStream.on("data", (c: string | Buffer) => {
            newContent += typeof c === "string" ? c : c.toString("utf-8");
          });
          readStream.on("end", () => {
            byteOffset = currentSize;
            processChunk(newContent);

            if (finished) {
              // Flush any remaining buffer content
              if (buffer.length > 0) {
                sendData(buffer);
                buffer = "";
              }
              resolve();
            } else {
              setTimeout(poll, 500);
            }
          });
          readStream.on("error", () => setTimeout(poll, 500));
        }

        // Abort handling
        request.signal.addEventListener("abort", () => {
          finished = true; // stop polling
          resolve();
        });

        // Start polling
        poll();
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
