import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCoderClientForUser } from "@/lib/coder/user-client";

const SOURCE_PATH = join(process.cwd(), "templates/ai-dev-k8s/scripts/agent-tools.py");
const MAX_OUTPUT = 256 * 1024;

export async function runWorkspaceAgentOperation(
  user: { id: string; coderUserId: string },
  workspaceId: string,
  operation: "inspect" | "install" | "disable" | "configure-coder" | "resume",
  key?: string,
): Promise<unknown> {
  const client = await getCoderClientForUser(user.id);
  const workspace = await client.getWorkspace(workspaceId);
  // Agent accounts and conversation metadata are private to the workspace owner.
  if (!user.coderUserId || workspace.owner_id !== user.coderUserId) {
    throw new Error("Only the workspace owner can manage agent tools and sessions.");
  }
  if (workspace.latest_build.status !== "running") throw new Error("Start this workspace first.");
  const resources = await client.getWorkspaceResources(workspaceId, workspace.latest_build.id);
  const agent = resources
    .flatMap((resource) => resource.agents ?? [])
    .find((item) => item.status === "connected");
  if (!agent) throw new Error("The workspace agent is not connected.");
  const target = `${workspace.owner_name}/${workspace.name}.${agent.name}`;
  if (!/^[a-zA-Z0-9._/-]+$/.test(target) || target.startsWith("-"))
    throw new Error("Invalid workspace target.");
  const source = await readFile(SOURCE_PATH, "utf8");
  const command = `python3 -c '${source.replace(/'/g, "'\\''")}'`;
  const payload = {
    operation,
    ...(key ? { key } : {}),
    ...(operation === "install" ? { source } : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(
      /* turbopackIgnore: true */ "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ProxyCommand=coder ssh --stdio --wait=no %h",
        target,
        command,
      ],
      {
        env: {
          ...process.env,
          CODER_URL: client.getBaseUrl(),
          CODER_SESSION_TOKEN: client.getSessionToken(),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Agent tools timed out. Refresh to try again."));
    }, 30_000);
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        child.kill();
        clearTimeout(timer);
        reject(new Error("Agent tools returned too much data."));
      } else output += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not connect to workspace agent tools."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || size > MAX_OUTPUT) throw new Error();
        const result = JSON.parse(output);
        if (result.ok !== true) throw new Error();
        resolve(result.data);
      } catch {
        reject(
          new Error("Agent operation failed. Check the workspace configuration and try again."),
        );
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
