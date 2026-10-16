import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCoderClientForUser } from "@/lib/coder/user-client";

export async function prepareNotificationWorkspace(userId: string, workspaceId: string) {
  const client = await getCoderClientForUser(userId);
  const workspace = await client.getWorkspace(workspaceId);
  // Only the owner can install account-wide hooks into this workspace's home.
  const { getDb } = await import("@hive/db");
  const user = await getDb().user.findUniqueOrThrow({ where: { id: userId } });
  if (workspace.owner_id !== user.coderUserId) throw new Error("Workspace owner required");
  if (workspace.latest_build.status !== "running") throw new Error("Start this workspace first");
  const resources = await client.getWorkspaceResources(workspaceId);
  const agent = resources
    .flatMap((resource) => resource.agents ?? [])
    .find((item) => item.status === "connected");
  if (!agent) throw new Error("Workspace agent is not connected");
  const target = `${workspace.owner_name}/${workspace.name}.${agent.name}`;
  if (!/^[a-zA-Z0-9._/-]+$/.test(target) || target.startsWith("-"))
    throw new Error("Invalid workspace target");
  return { client, target, workspaceName: workspace.name };
}

export async function installNotificationHooks(
  prepared: Awaited<ReturnType<typeof prepareNotificationWorkspace>>,
  url: string,
  token: string,
  version: { sourceId: string; generation: number; createdAt: string },
) {
  const { client, target } = prepared;
  const [installer, hook] = await Promise.all([
    readFile(join(process.cwd(), "scripts/notifications/install.py"), "utf8"),
    readFile(join(process.cwd(), "scripts/notifications/agent-hook.py"), "utf8"),
  ]);
  const command = `python3 -c '${installer.replace(/'/g, "'\\''")}'`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("coder", ["ssh", "--wait=no", target, "--", command], {
      env: {
        ...process.env,
        CODER_URL: client.getBaseUrl(),
        CODER_SESSION_TOKEN: client.getSessionToken(),
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Workspace setup timed out"));
    }, 20_000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Workspace setup unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error("Could not install hooks; check existing agent configuration"));
    });
    child.stdin.on("error", () => {});
    // Keep the scoped callback credential out of commands, logs, and URLs.
    child.stdin.end(JSON.stringify({ hook, token, url, ...version }));
  });
  return prepared.workspaceName;
}
