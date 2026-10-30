import { createPrivateKey } from "node:crypto";
import {
  AuthServiceClient,
  authServiceHeaders,
  SECURE_SESSION_COOKIE_NAME,
  verifyCookie,
} from "@hive/auth";
import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { z } from "zod";
import { getCoderClientForUser } from "../../../src/lib/coder/user-client";
import { openPortableVoiceClient } from "../../../src/lib/codex/voice-portable-client.server";
import type { VoiceRpc } from "../../../src/lib/codex/voice-rpc";
import { createVoiceStream, listVoiceThreads } from "../../../src/lib/codex/voice-session";
import {
  resolveVerifiedWorkspaceHost,
  type VerifiedHostBinding,
} from "../../../src/lib/codex-session/registration.server";

export type VoiceEnvironment = {
  DATABASE_URL?: string;
  AUTH_SERVICE?: { fetch: typeof fetch };
  AUTH_SERVICE_SECRET?: string;
  COOKIE_SECRET?: string;
  CODER_URL?: string;
  HIVE_PREVIEW_ORIGIN?: string;
  HIVE_CODEX_VOICE_ENABLED?: string;
  HIVE_VOICE_TRANSPORT?: string;
  HIVE_VOICE_ISSUER_PRIVATE_KEY?: string;
  HIVE_VOICE_ISSUER_KEY_ID?: string;
  HIVE_VOICE_TEMPLATE_PINS_JSON?: string;
  COOKIE_DOMAIN?: string;
};
type Context = { waitUntil(promise: Promise<unknown>): void };
const uuid = z.string().uuid();
const pins = z
  .array(
    z.object({ templateId: uuid, manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  )
  .min(1)
  .max(32);
const path =
  /^\/api\/workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/voice$/i;
let active = 0;
const error = (status: number, message = "Voice transport unavailable") =>
  new Response(message, { status, headers: { "Cache-Control": "private, no-store" } });
export function voicePath(request: Request) {
  return path.test(new URL(request.url).pathname);
}
function configuration(env: VoiceEnvironment) {
  if (
    env.HIVE_CODEX_VOICE_ENABLED !== "true" ||
    env.HIVE_VOICE_TRANSPORT !== "workspace-app" ||
    !env.AUTH_SERVICE ||
    !env.AUTH_SERVICE_SECRET ||
    !env.COOKIE_SECRET ||
    !env.DATABASE_URL
  )
    throw new Error("disabled");
  authServiceHeaders(env.AUTH_SERVICE_SECRET);
  const origin = new URL(env.HIVE_PREVIEW_ORIGIN ?? ""),
    coder = new URL(env.CODER_URL ?? ""),
    privateKeyPem = env.HIVE_VOICE_ISSUER_PRIVATE_KEY ?? "",
    keyId = env.HIVE_VOICE_ISSUER_KEY_ID ?? "",
    lockDirectory = "/home/coder/.codex/hive-voice",
    profiles = pins.parse(JSON.parse(env.HIVE_VOICE_TEMPLATE_PINS_JSON ?? ""));
  if (
    origin.protocol !== "https:" ||
    origin.origin !== env.HIVE_PREVIEW_ORIGIN ||
    coder.protocol !== "https:" ||
    coder.origin !== env.CODER_URL ||
    createPrivateKey(privateKeyPem).asymmetricKeyType !== "ed25519" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(keyId) ||
    new Set(profiles.map((p) => p.templateId)).size !== profiles.length
  )
    throw new Error("configuration");
  return {
    origin: origin.origin,
    coderOrigin: coder.origin,
    privateKeyPem,
    keyId,
    lockDirectory,
    profiles,
    cookieDomains: env.COOKIE_DOMAIN ? [env.COOKIE_DOMAIN] : [],
  };
}
function sessionId(request: Request, secret: string) {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${SECURE_SESSION_COOKIE_NAME}=`));
  if (values.length !== 1) throw new Error("session");
  const value = verifyCookie(values[0].slice(SECURE_SESSION_COOKIE_NAME.length + 1), secret);
  if (!value) throw new Error("session");
  return value.sessionId;
}
async function authorize(
  env: VoiceEnvironment,
  config: ReturnType<typeof configuration>,
  session: string,
  workspaceId: string,
  signal: AbortSignal,
) {
  const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
    queryTimeoutMillis: 10000,
    transactionTimeoutMillis: 10000,
  });
  try {
    return await database.run(async () => {
      const auth = new AuthServiceClient("https://hive-auth.internal", 5000, {
        serviceSecret: env.AUTH_SERVICE_SECRET,
        fetch: (input, init) => {
          if (!env.AUTH_SERVICE) throw new Error("auth unavailable");
          return env.AUTH_SERVICE.fetch(input, {
            ...init,
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
          });
        },
      });
      const current = await auth.getSession(session);
      signal.throwIfAborted();
      const expiresAt = Date.parse(current?.expiresAt ?? "");
      if (
        !current ||
        current.sessionId !== session ||
        current.coderUrl.replace(/\/+$/, "") !== config.coderOrigin ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      )
        throw new Error("session");
      const principal = { hiveUserId: current.userId, coderUserId: current.coderUserId };
      const user = await getDb().user.findUnique({
        where: { id: principal.hiveUserId },
        select: { coderUserId: true },
      });
      signal.throwIfAborted();
      if (!user || user.coderUserId !== principal.coderUserId) throw new Error("user");
      const coder = await getCoderClientForUser(principal.hiveUserId, { signal });
      const { binding } = await resolveVerifiedWorkspaceHost(
        {
          hiveOrigin: config.origin,
          softwareTemplateIds: config.profiles.map((p) => p.templateId),
          appSlug: "hive-voice",
          gatewayPort: 13343,
          cookieDomains: config.cookieDomains,
        },
        async () => coder,
        principal,
        workspaceId,
      );
      signal.throwIfAborted();
      return { principal, coder, binding, expiresAt };
    });
  } finally {
    await database.close();
  }
}
const sameBinding = (a: VerifiedHostBinding, b: VerifiedHostBinding) =>
  JSON.stringify(a) === JSON.stringify(b);
async function offer(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return error(415, "Expected JSON");
  const reader = request.body?.getReader();
  if (!reader) return error(400, "Missing offer");
  let size = 0,
    text = "";
  const decoder = new TextDecoder();
  const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  deadline.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        return error(413, "Offer too large");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    deadline.throwIfAborted();
    text += decoder.decode();
  } catch {
    return error(400, "Invalid offer");
  } finally {
    deadline.removeEventListener("abort", cancel);
  }
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      typeof value.threadId !== "string" ||
      !uuid.safeParse(value.threadId).success ||
      typeof value.sdp !== "string" ||
      !value.sdp.startsWith("v=0") ||
      !value.sdp.includes("m=audio")
    )
      throw new Error();
    return { threadId: value.threadId as string, sdp: value.sdp as string };
  } catch {
    return error(400, "Invalid voice offer");
  }
}
export async function voiceRuntime(
  request: Request,
  env: VoiceEnvironment,
  previewExpiresAt: number,
  context: Context,
) {
  const match = path.exec(new URL(request.url).pathname);
  if (!match || new URL(request.url).search || !["GET", "POST"].includes(request.method))
    return error(404);
  let config: ReturnType<typeof configuration>, session: string;
  try {
    config = configuration(env);
  } catch {
    return error(503);
  }
  try {
    session = sessionId(request, env.COOKIE_SECRET ?? "");
  } catch {
    return error(401, "Not authenticated");
  }
  if (
    new URL(request.url).origin !== config.origin ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (request.method === "POST" && request.headers.get("origin") !== config.origin)
  )
    return error(403, "Invalid origin");
  if (previewExpiresAt <= Date.now() || active >= 4) return error(503);
  const body = request.method === "POST" ? await offer(request) : undefined;
  if (body instanceof Response) return body;
  if (previewExpiresAt <= Date.now() || active >= 4) return error(503);
  active++;
  let released = false,
    rpc: VoiceRpc | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    deadlineTimer: ReturnType<typeof setTimeout> | undefined,
    pending: Promise<void> | undefined,
    setupSignal: AbortSignal | undefined,
    setupAbort: (() => void) | undefined;
  let finishLifecycle: () => void = () => {};
  const lifecycle = new Promise<void>((resolve) => {
    finishLifecycle = resolve;
  });
  const abort = new AbortController();
  const callAbort = new AbortController();
  const release = () => {
    if (released) return;
    released = true;
    active--;
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
    if (setupSignal && setupAbort) setupSignal.removeEventListener("abort", setupAbort);
    abort.abort();
    if (pending) void pending.finally(finishLifecycle);
    else finishLifecycle();
  };
  context.waitUntil(lifecycle);
  try {
    const setup = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(10000)]);
    setupSignal = setup;
    const initial = await authorize(env, config, session, match[1], setup);
    const pin = config.profiles.find((p) => p.templateId === initial.binding.templateId);
    if (!pin) throw new Error();
    rpc = await openPortableVoiceClient(
      {
        privateKeyPem: config.privateKeyPem,
        keyId: config.keyId,
        issuer: config.origin,
        manifestSha256: pin.manifestSha256,
        lockDirectory: config.lockDirectory,
      },
      initial.coder,
      initial.binding,
      body?.threadId,
      setup,
      fetch,
      release,
    );
    setupAbort = () => rpc?.close();
    setup.addEventListener("abort", setupAbort, { once: true });
    setup.throwIfAborted();
    const current = await authorize(env, config, session, match[1], setup);
    if (
      !sameBinding(initial.binding, current.binding) ||
      current.principal.hiveUserId !== initial.principal.hiveUserId ||
      current.principal.coderUserId !== initial.principal.coderUserId
    )
      throw new Error();
    const threads = await listVoiceThreads(rpc);
    setup.throwIfAborted();
    if (!body) {
      rpc.close();
      return Response.json({ threads }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!threads.some((thread) => thread.id === body.threadId)) {
      rpc.close();
      return error(409, "Select a running Codex session");
    }
    const cap = Math.min(
      previewExpiresAt,
      initial.expiresAt,
      current.expiresAt,
      Date.now() + 30 * 60_000,
    );
    if (cap <= Date.now()) throw new Error();
    deadlineTimer = setTimeout(() => callAbort.abort(), cap - Date.now());
    const refresh = () => {
      if (released) return;
      pending = (async () => {
        const fresh = await authorize(
          env,
          config,
          session,
          match[1],
          AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
        );
        if (
          !sameBinding(initial.binding, fresh.binding) ||
          fresh.principal.hiveUserId !== initial.principal.hiveUserId ||
          fresh.principal.coderUserId !== initial.principal.coderUserId ||
          fresh.expiresAt < cap
        )
          throw new Error();
      })()
        .then(
          () => {
            if (!released) timer = setTimeout(refresh, 20000);
          },
          () => callAbort.abort(),
        )
        .finally(() => {
          pending = undefined;
        });
    };
    timer = setTimeout(refresh, 20000);
    setup.removeEventListener("abort", setupAbort);
    setupSignal = undefined;
    setupAbort = undefined;
    return new Response(
      createVoiceStream(
        rpc,
        body.threadId,
        body.sdp,
        AbortSignal.any([request.signal, callAbort.signal]),
      ),
      {
        headers: {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
        },
      },
    );
  } catch {
    rpc?.close();
    release();
    return error(502);
  }
}
