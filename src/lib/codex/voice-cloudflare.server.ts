import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getRequestSession } from "@/lib/auth/session";
import {
  authorizeOwnedWorkspacePty,
  type GenericTerminalEnvironment,
} from "../../../deploy/cloudflare/app/generic-terminal-runtime";
import { openVoicePty } from "./voice-pty.server";

export async function connectCloudflareCodexVoice(
  userId: string,
  workspaceId: string,
  signal: AbortSignal,
  threadId?: string,
) {
  const session = await getRequestSession();
  signal.throwIfAborted();
  if (!session || session.user.id !== userId) throw Error("Voice session unavailable");
  const { env, ctx } = getCloudflareContext();
  const voiceEnv = env as GenericTerminalEnvironment;
  return openVoicePty(
    {
      async authorize(callerSignal) {
        const authority = await authorizeOwnedWorkspacePty(
          session.session.sessionId,
          voiceEnv,
          workspaceId,
          undefined,
          callerSignal,
        );
        if (authority.userId !== userId) throw Error("Voice session changed");
        return authority;
      },
      track: (promise) => ctx.waitUntil(promise),
    },
    signal,
    threadId,
  );
}
