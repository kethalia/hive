import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { WebSocket } from "ws";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { VoiceRpc } from "./voice-rpc";

export async function connectWorkspaceCodex(
  userId: string,
  workspaceId: string,
  signal: AbortSignal,
  threadId?: string,
) {
  if (threadId && !/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error("Invalid Codex thread");
  const client = await getCoderClientForUser(userId);
  // Resolve under the requesting user's Coder credentials, including the owner.
  const workspace = await client.getWorkspace(workspaceId);
  const resources = await client.getWorkspaceResources(workspaceId);
  const agent = resources
    .flatMap((resource) => resource.agents ?? [])
    .find((item) => item.status === "connected");
  if (!agent) throw new Error("Workspace agent is not connected");
  const target = `${workspace.owner_name}/${workspace.name}.${agent.name}`;
  if (!/^[a-zA-Z0-9._/-]+$/.test(target) || target.startsWith("-"))
    throw new Error("Invalid workspace target");
  signal.throwIfAborted();
  // Codex's control socket speaks WebSocket, not JSONL. SSH carries its HTTP
  // upgrade and frames; no public Codex listener or workspace image change.
  const child = spawn(
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
      "ProxyCommand=coder ssh --stdio %h",
      target,
      threadId
        ? `bash -lc 'umask 077; mkdir -p "\${CODEX_HOME:-$HOME/.codex}/hive-voice" && exec flock -n "\${CODEX_HOME:-$HOME/.codex}/hive-voice/${threadId}.lock" codex app-server proxy'`
        : "bash -lc 'exec codex app-server proxy'",
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
  child.stderr.resume(); // Drain without logging workspace output or credentials.
  const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
  const socket = new WebSocket("ws://localhost/", {
    createConnection: () => transport as Socket,
    handshakeTimeout: 10_000,
    maxPayload: 2 * 1024 * 1024,
  });
  const dispose = () => {
    child.kill();
    transport.destroy();
  };
  const rpc = new VoiceRpc(socket, dispose);
  child.on("error", () => rpc.close());
  child.on("exit", () => rpc.close());
  const abort = () => rpc.close();
  signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", abort));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () =>
        reject(
          new Error(
            "Could not reach Codex. Open a current Codex CLI session in this workspace first.",
          ),
        ),
      );
      socket.once("close", () => reject(new Error("Codex connection closed")));
    });
    await rpc.initialize();
    signal.removeEventListener("abort", abort);
    signal.throwIfAborted();
    return rpc;
  } catch (error) {
    rpc.close();
    throw error;
  }
}
