import { execFile } from "child_process";

export interface ExecOptions {
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Execute a command inside a Coder workspace via `coder ssh`.
 * Uses `bash -l -c` (login shell) so tools installed via nvm/pnpm are on PATH.
 * Never throws on non-zero exit — always returns a structured ExecResult.
 */
export function execInWorkspace(
  workspaceName: string,
  command: string,
  opts?: ExecOptions,
): Promise<ExecResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const truncatedCmd =
    command.length > 100 ? command.slice(0, 100) + "…" : command;

  console.log(
    `[exec] workspace=${workspaceName} cmd="${truncatedCmd}" timeout=${timeoutMs}ms`,
  );

  return new Promise((resolve) => {
    execFile(
      "coder",
      ["ssh", workspaceName, "--", "bash", "-l", "-c", command],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          // Timeout: killed by Node or explicit timeout error code
          if (
            error.killed ||
            (error as NodeJS.ErrnoException).code ===
              "ERR_CHILD_PROCESS_TIMEOUT"
          ) {
            console.log(
              `[exec] workspace=${workspaceName} cmd="${truncatedCmd}" timed out after ${timeoutMs}ms`,
            );
            resolve({
              stdout: stdout ?? "",
              stderr:
                stderr || `Command timed out after ${timeoutMs}ms`,
              exitCode: 124, // conventional timeout exit code
            });
            return;
          }

          // Non-zero exit — Node sets error.code to the exit status number
          // for exec/execFile when the child exits with a non-zero code
          const exitCode =
            typeof (error as NodeJS.ErrnoException).code === "number"
              ? ((error as NodeJS.ErrnoException).code as unknown as number)
              : 1;
          console.log(
            `[exec] workspace=${workspaceName} cmd="${truncatedCmd}" exitCode=${exitCode}`,
          );
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? error.message,
            exitCode,
          });
          return;
        }

        console.log(
          `[exec] workspace=${workspaceName} cmd="${truncatedCmd}" exitCode=0`,
        );
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 });
      },
    );
  });
}
