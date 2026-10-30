import { timingSafeEqual } from "node:crypto";

export const RELEASE_HEALTH_PATH = "/.well-known/hive-release-health";
type ReleaseHealthEnvironment = {
  HIVE_RELEASE_HEALTH_ENABLED?: string;
  HIVE_RELEASE_PROBE_SECRET?: string;
  HIVE_RELEASE_SOURCE_SHA?: string;
  HIVE_RELEASE_ARTIFACT_DIGEST?: string;
};
const headers = { "Cache-Control": "private, no-store", Vary: "X-Hive-Release-Probe" };
export async function withReleaseDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs = 2000,
): Promise<T> {
  if (parent.aborted) throw new Error("release_probe_aborted");
  const controller = new AbortController();
  let rejectGuard!: (reason: Error) => void;
  const guard = new Promise<never>((_resolve, reject) => {
    rejectGuard = reject;
  });
  const abort = () => {
    controller.abort();
    rejectGuard(new Error("release_probe_aborted"));
  };
  const timer = setTimeout(abort, timeoutMs);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const work = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new Error("release_probe_aborted");
    return operation(controller.signal);
  });
  void work.catch(() => {});
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
    controller.abort();
  }
}
export async function boundedReleaseJson(
  response: Response,
  maxBytes = 4096,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new Error("response missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(new Error("release_probe_aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* Pending reads are canceled above. */
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function releaseAuthReadiness(
  fetcher: (request: Request) => Promise<Response>,
  secret: string,
  parent: AbortSignal,
  timeoutMs = 2000,
): Promise<unknown> {
  return withReleaseDeadline(
    async (signal) => {
      const response = await fetcher(
        new Request(`https://auth.internal${RELEASE_HEALTH_PATH}`, {
          signal,
          headers: { "X-Hive-Release-Probe": secret },
        }),
      );
      if (!response.ok) throw new Error("auth unavailable");
      return boundedReleaseJson(response, 4096, signal);
    },
    parent,
    timeoutMs,
  );
}
function validSecret(secret: unknown): secret is string {
  return typeof secret === "string" && /^[a-f0-9]{64}$/.test(secret);
}
/** Private, explicitly enabled readiness. Build metadata is a self-report;
 * the release controller must independently verify provider/version/build
 * attestation before using it as health evidence. */
export async function releaseHealth(
  request: Request,
  env: ReleaseHealthEnvironment,
  component: "app" | "auth",
  ready: () => Promise<boolean>,
  authReady?: () => Promise<unknown>,
): Promise<Response> {
  if (
    request.method !== "GET" ||
    new URL(request.url).pathname !== RELEASE_HEALTH_PATH ||
    new URL(request.url).search
  )
    return new Response(null, { status: 404, headers });
  if (env.HIVE_RELEASE_HEALTH_ENABLED !== "true" || !validSecret(env.HIVE_RELEASE_PROBE_SECRET))
    return new Response(null, { status: 404, headers });
  const actual = Buffer.from(request.headers.get("x-hive-release-probe") ?? ""),
    expected = Buffer.from(env.HIVE_RELEASE_PROBE_SECRET);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return new Response(null, { status: 401, headers });
  if (
    !/^[a-f0-9]{40}$/.test(env.HIVE_RELEASE_SOURCE_SHA ?? "") ||
    !/^[a-f0-9]{64}$/.test(env.HIVE_RELEASE_ARTIFACT_DIGEST ?? "")
  )
    return new Response(null, { status: 503, headers });
  try {
    if (!(await withReleaseDeadline(async () => ready(), request.signal)))
      throw new Error("not ready");
    const own = {
      component,
      sourceSha: env.HIVE_RELEASE_SOURCE_SHA,
      artifactDigest: env.HIVE_RELEASE_ARTIFACT_DIGEST,
      ready: true,
    };
    if (component === "auth") return Response.json(own, { headers });
    if (!authReady) throw new Error("auth unavailable");
    const auth = await authReady();
    if (
      !auth ||
      typeof auth !== "object" ||
      (auth as { component?: unknown }).component !== "auth" ||
      (auth as { ready?: unknown }).ready !== true ||
      !/^[a-f0-9]{40}$/.test(String((auth as { sourceSha?: unknown }).sourceSha)) ||
      !/^[a-f0-9]{64}$/.test(String((auth as { artifactDigest?: unknown }).artifactDigest))
    )
      throw new Error("auth unavailable");
    const sanitizedAuth = {
      component: "auth",
      ready: true,
      sourceSha: (auth as { sourceSha: string }).sourceSha,
      artifactDigest: (auth as { artifactDigest: string }).artifactDigest,
    };
    return Response.json({ schemaVersion: 1, app: own, auth: sanitizedAuth }, { headers });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
