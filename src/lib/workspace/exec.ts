import { execFile } from "child_process";
import { DEFAULT_EXEC_TIMEOUT_MS } from "@/lib/constants";

export interface ExecOptions {
  timeoutMs?: number;
  loginShell?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a command inside a Coder workspace via `coder ssh`.
 * Uses the `coder` CLI directly rather than native SSH with `coder config-ssh`,
 * because the config-ssh ProxyCommand embeds the coder binary's temp path
 * which changes on workspace restart.
 * By default runs the command directly. Set `loginShell: true` to wrap
 * in `bash -l -c` for commands that need nvm/pnpm on PATH.
 * Never throws on non-zero exit — always returns a structured ExecResult.
 */
export function execInWorkspace(
  workspaceName: string,
  command: string,
  opts?: ExecOptions,
): Promise<ExecResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const loginShell = opts?.loginShell ?? false;
  const truncatedCmd =
    command.length > 100 ? command.slice(0, 100) + "…" : command;

  console.log(
    `[exec] workspace=${workspaceName} cmd="${truncatedCmd}" timeout=${timeoutMs}ms`,
  );

  const shellCmd = loginShell ? `bash -l -c ${shellQuote(command)}` : command;

  return new Promise((resolve) => {
    execFile(
      "coder",
      ["ssh", "--wait=no", workspaceName, "--", shellCmd],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
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
              stderr: stderr || `Command timed out after ${timeoutMs}ms`,
              exitCode: 124,
            });
            return;
          }

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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
