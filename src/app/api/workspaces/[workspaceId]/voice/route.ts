import { getRequestSession } from "@/lib/auth/session";
import { connectWorkspaceCodex } from "@/lib/codex/voice-connection";
import type { VoiceRpc } from "@/lib/codex/voice-rpc";
import { createVoiceStream, listVoiceThreads } from "@/lib/codex/voice-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Context = { params: Promise<{ workspaceId: string }> };

function hasAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === new URL(request.url).origin) return true;

  // Reverse proxies can replace the request URL's hostname. Forwarded headers
  // authorize signaling only when they match an explicitly configured origin.
  const configured = [
    process.env.HIVE_PUBLIC_ORIGIN ?? "",
    ...(process.env.HIVE_VOICE_ALLOWED_ORIGINS ?? "").split(","),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  if (!configured.length) return false;
  try {
    const allowed = configured.map((value) => new URL(value));
    if (
      allowed.some(
        (url) =>
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash,
      )
    )
      return false;
    return allowed.some(
      (url) =>
        origin === url.origin &&
        request.headers.get("x-forwarded-host") === url.host &&
        request.headers.get("x-forwarded-proto") === url.protocol.slice(0, -1),
    );
  } catch {
    return false;
  }
}

async function authorize(request: Request, context: Context) {
  if (process.env.HIVE_CODEX_VOICE_ENABLED !== "true")
    return new Response("Voice prototype is disabled", { status: 404 });
  const session = await getRequestSession();
  if (!session) return new Response("Not authenticated", { status: 401 });
  // Reject cross-site signaling even when cookies could be sent by the browser.
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (request.method === "POST" && !hasAllowedOrigin(request))
  ) {
    return new Response("Invalid origin", { status: 403 });
  }
  const { workspaceId } = await context.params;
  if (!UUID.test(workspaceId)) return new Response("Invalid workspace", { status: 400 });
  return { userId: session.user.id, workspaceId };
}

export async function GET(request: Request, context: Context) {
  const auth = await authorize(request, context);
  if (auth instanceof Response) return auth;
  let rpc: VoiceRpc | undefined;
  const abort = () => rpc?.close();
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    rpc = await connectWorkspaceCodex(auth.userId, auth.workspaceId, request.signal);
    request.signal.throwIfAborted();
    return Response.json(
      { threads: await listVoiceThreads(rpc) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        error:
          "Could not list Codex sessions. Open a current Codex CLI session in this workspace first.",
      },
      { status: 502 },
    );
  } finally {
    request.signal.removeEventListener("abort", abort);
    rpc?.close();
  }
}

export async function POST(request: Request, context: Context) {
  const auth = await authorize(request, context);
  if (auth instanceof Response) return auth;
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return new Response("Expected JSON", { status: 415 });
  // Bound the streamed request body too, not just its untrusted Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return new Response("Missing offer", { status: 400 });
  let body = "";
  const decoder = new TextDecoder();
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        return new Response("Offer too large", { status: 413 });
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    return new Response("Invalid offer", { status: 400 });
  }
  let input: { threadId?: unknown; sdp?: unknown };
  try {
    input = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (
    !input ||
    typeof input.threadId !== "string" ||
    !UUID.test(input.threadId) ||
    typeof input.sdp !== "string" ||
    !input.sdp.startsWith("v=0") ||
    !input.sdp.includes("m=audio")
  ) {
    return new Response("Invalid voice offer", { status: 400 });
  }
  let rpc: VoiceRpc | undefined;
  const abort = () => rpc?.close();
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    rpc = await connectWorkspaceCodex(
      auth.userId,
      auth.workspaceId,
      request.signal,
      input.threadId,
    );
    request.signal.throwIfAborted();
    const threads = await listVoiceThreads(rpc);
    if (!threads.some((thread) => thread.id === input.threadId)) {
      rpc.close();
      return new Response("Select a running Codex session", { status: 409 });
    }
    return new Response(createVoiceStream(rpc, input.threadId, input.sdp, request.signal), {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    rpc?.close();
    return new Response(
      "Could not connect to Codex. End any existing Hive voice call and check the workspace session.",
      { status: 502 },
    );
  } finally {
    request.signal.removeEventListener("abort", abort);
  }
}
