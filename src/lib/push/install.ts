import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { callbackTokenHash } from "./source-credentials";

export async function prepareNotificationWorkspace(
  userId: string,
  workspaceId: string,
  signal?: AbortSignal,
) {
  const client = await getCoderClientForUser(userId, { signal });
  const workspace = await client.getWorkspace(workspaceId, signal);
  // Only the owner can install account-wide hooks into this workspace's home.
  const { getDb } = await import("@hive/db");
  const user = await getDb().user.findUniqueOrThrow({ where: { id: userId } });
  if (workspace.owner_id !== user.coderUserId) throw new Error("Workspace owner required");
  if (workspace.latest_build.status !== "running") throw new Error("Start this workspace first");
  const resources = await client.getWorkspaceResources(workspaceId, workspace.latest_build.id);
  const agent = resources
    .flatMap((resource) => resource.agents ?? [])
    .find((item) => item.status === "connected");
  if (!agent) throw new Error("Workspace agent is not connected");
  const target = `${workspace.owner_name}/${workspace.name}.${agent.name}`;
  if (!/^[a-zA-Z0-9._/-]+$/.test(target) || target.startsWith("-"))
    throw new Error("Invalid workspace target");
  signal?.throwIfAborted();
  return {
    client,
    target,
    workspaceName: workspace.name,
    workspaceId,
    buildId: workspace.latest_build.id,
    agentId: agent.id,
  };
}

export async function installNotificationHooks(
  prepared: Awaited<ReturnType<typeof prepareNotificationWorkspace>>,
  url: string,
  token: string,
  version: { sourceId: string; generation: number; createdAt: string },
  signal?: AbortSignal,
) {
  if (process.env.HIVE_RUNTIME_TARGET === "cloudflare") {
    const [{ execInWorkspace }, { readRuntimeArtifact }] = await Promise.all([
      import("@/lib/workspace/exec"),
      import("@/lib/workspace/runtime-artifacts.server"),
    ]);
    const [installer, hook] = await Promise.all([
      readRuntimeArtifact("scripts/notifications/install.py"),
      readRuntimeArtifact("scripts/notifications/agent-hook.py"),
    ]);
    signal?.throwIfAborted();
    const result = await execInWorkspace(
      prepared.target,
      `python3 -c '${installer.replace(/'/g, "'\\''")}'`,
      {
        coderUrl: prepared.client.getBaseUrl(),
        sessionToken: prepared.client.getSessionToken(),
        timeoutMs: 20000,
        maxBufferBytes: 4096,
        stdin: JSON.stringify({ hook, token, url, ...version, portable: true }),
        signal,
        expected: {
          workspaceId: prepared.workspaceId,
          buildId: prepared.buildId,
          agentId: prepared.agentId,
        },
      },
    );
    signal?.throwIfAborted();
    if (result.exitCode !== 0) throw new Error("setup_outcome_unknown");
    let receipt: unknown;
    try {
      receipt = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error("setup_outcome_unknown");
    }
    const parsed = z
      .object({
        sourceId: z.string(),
        generation: z.number().int(),
        createdAt: z.string(),
        credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
        callbackOrigin: z.string().url(),
      })
      .strict();
    const envelope = z
      .object({ ok: z.literal(true), data: parsed })
      .strict()
      .safeParse(receipt);
    const parsedReceipt = envelope.success
      ? { success: true as const, data: envelope.data.data }
      : { success: false as const };
    if (
      !parsedReceipt.success ||
      parsedReceipt.data.sourceId !== version.sourceId ||
      parsedReceipt.data.generation !== version.generation ||
      parsedReceipt.data.createdAt !== version.createdAt ||
      parsedReceipt.data.credentialHash !== callbackTokenHash(token) ||
      parsedReceipt.data.callbackOrigin !== new URL(url).origin
    )
      throw new Error("setup_outcome_unknown");
    return prepared.workspaceName;
  }
  const { client, target } = prepared;
  const [installer, hook] = await Promise.all([
    readFile(join(process.cwd(), "scripts/notifications/install.py"), "utf8"),
    readFile(join(process.cwd(), "scripts/notifications/agent-hook.py"), "utf8"),
  ]);
  const command = `python3 -c '${installer.replace(/'/g, "'\\''")}'`;
  await new Promise<void>((resolve, reject) => {
    // Use an SSH exec channel without a PTY. The pinned Coder CLI's interactive
    // stdin forwarding can echo the credential and leave json.load waiting for EOF.
    const child = spawn(
      /* turbopackIgnore: true */
      "ssh",
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
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    // Drain diagnostics without logging commands or callback credentials.
    child.stderr.resume();
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
