import { spawn, type ChildProcess } from "child_process";

export interface StreamResult {
  stdout: ReadableStream<string>;
  process: ChildProcess;
}

/**
 * Stream output from a Coder workspace via `coder ssh`.
 *
 * Uses `spawn` (not `execFile`) to get a live readable stream.
 * Accumulates a string buffer and yields complete lines split on `\n`.
 * Kills the child process when the AbortSignal fires.
 *
 * Lifecycle events are logged with `[stream]` prefix for diagnostics.
 */
export function streamFromWorkspace(
  workspaceName: string,
  command: string,
  signal?: AbortSignal,
): StreamResult {
  const truncatedCmd =
    command.length > 100 ? command.slice(0, 100) + "…" : command;

  console.log(
    `[stream] spawning: workspace=${workspaceName} cmd="${truncatedCmd}"`,
  );

  const child = spawn(
    "coder",
    ["ssh", workspaceName, "--", "bash", "-l", "-c", command],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let buffer = "";
  let streamController: ReadableStreamDefaultController<string> | null = null;

  const readable = new ReadableStream<string>({
    start(controller) {
      streamController = controller;

      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        // Keep the last element — it may be an incomplete line
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          try {
            controller.enqueue(line);
          } catch {
            // Stream already closed — ignore
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        console.log(
          `[stream] stderr: workspace=${workspaceName} ${chunk.toString("utf-8").trim()}`,
        );
      });

      child.on("close", (code) => {
        console.log(
          `[stream] closed: workspace=${workspaceName} exitCode=${code}`,
        );
        // Flush any remaining buffered content
        if (buffer.length > 0) {
          try {
            controller.enqueue(buffer);
          } catch {
            // Stream already closed
          }
          buffer = "";
        }
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });

      child.on("error", (err) => {
        console.log(
          `[stream] error: workspace=${workspaceName} ${err.message}`,
        );
        try {
          controller.error(err);
        } catch {
          // Already closed
        }
      });
    },
    cancel() {
      console.log(
        `[stream] cancelled: workspace=${workspaceName}`,
      );
      killWithEscalation(child, workspaceName);
    },
  });

  // AbortSignal handling — kill child when the signal fires
  if (signal) {
    if (signal.aborted) {
      killWithEscalation(child, workspaceName);
    } else {
      const onAbort = () => {
        console.log(
          `[stream] aborted: workspace=${workspaceName}`,
        );
        killWithEscalation(child, workspaceName);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      // Clean up the listener when the child exits
      child.on("close", () => {
        signal.removeEventListener("abort", onAbort);
      });
    }
  }

  return { stdout: readable, process: child };
}

/**
 * Kill a child process with SIGTERM, escalating to SIGKILL after 5 seconds
 * if the process hasn't exited. Prevents zombie `coder ssh` processes.
 */
function killWithEscalation(child: ChildProcess, workspaceName: string): void {
  if (child.exitCode !== null) return; // already exited

  child.kill("SIGTERM");

  const escalationTimer = setTimeout(() => {
    if (child.exitCode === null) {
      console.log(
        `[stream] SIGKILL escalation: workspace=${workspaceName} (SIGTERM ignored after 5s)`,
      );
      child.kill("SIGKILL");
    }
  }, 5_000);

  // Don't let the timer keep the process alive
  escalationTimer.unref();

  // Clear timer if the child exits in time
  child.on("close", () => clearTimeout(escalationTimer));
}
