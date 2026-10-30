import { createHash } from "node:crypto";
import type { CoderClient } from "@/lib/coder/client";
import type {
  RegistrationBinding,
  RegistrationPrincipal,
  WorkspaceRegistrationAuthority,
} from "./registration.server";
import { RegistrationRejected } from "./registration-store.server";

if (typeof window !== "undefined") throw new Error("Bootstrap delivery is server-only.");
const smuggle = "coder_application_connect_api_key_35e783";

function reject(): never {
  throw new RegistrationRejected();
}
function location(response: Response, origin: string, path: string, query: boolean) {
  const raw = response.headers.get("location");
  if (!raw || raw.length > 16384) reject();
  const url = new URL(raw, origin);
  if (url.origin !== origin || url.pathname !== path || url.username || url.password || url.hash)
    reject();
  if (!query && url.search) reject();
  return url;
}
function boundedHeaders(response: Response) {
  let size = 0;
  response.headers.forEach((v, k) => {
    size += v.length + k.length;
  });
  if (size > 32768) reject();
}
async function boundedJson(response: Response, limit: number, signal?: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) reject();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (let count = 0; count < 4096; count++) {
      signal?.throwIfAborted();
      const r = await reader.read();
      signal?.throwIfAborted();
      if (r.done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      size += r.value.length;
      if (size > limit) reject();
      chunks.push(r.value);
    }
    reject();
  } finally {
    signal?.removeEventListener("abort", abort);
    if (signal) void reader.cancel().catch(() => {});
    else await reader.cancel().catch(() => {});
  }
}
type AppAuthCoder = Pick<
  CoderClient,
  "getApplicationAuthRedirect" | "getApplicationsHost" | "getBaseUrl"
>;
type AppBinding = Pick<RegistrationBinding, "coderOrigin" | "appOrigin">;
export type HostProjectPath =
  | "/registration/bootstrap"
  | "/guardian/identity"
  | "/guardian/bootstrap"
  | "/projects/discover"
  | "/projects/resolve"
  | "/projects/resolve-ref"
  | "/projects/open"
  | "/projects/tasks/start"
  | "/projects/tasks/status"
  | "/projects/tasks/retry";
async function exchangeAppCookie(
  coder: AppAuthCoder,
  binding: AppBinding,
  fixedPath: HostProjectPath | "/session" | "/terminal" | "/workspace/read",
  expiresAt: number,
  fetchApp: typeof fetch,
) {
  const b = binding,
    origin = new URL(b.appOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== b.appOrigin ||
    origin.username ||
    origin.password ||
    coder.getBaseUrl() !== b.coderOrigin
  )
    reject();
  const remaining = expiresAt * 1000 - Date.now();
  if (remaining < 1000) reject();
  const deadline = Date.now() + Math.min(10000, remaining);
  const signal = () => {
    if (Date.now() >= deadline) reject();
    return AbortSignal.timeout(deadline - Date.now());
  };
  // This canonical method sends the owner token exclusively to its pinned Coder API.
  const target = b.appOrigin + fixedPath;
  const auth = await coder.getApplicationAuthRedirect(target);
  if (auth.length > 16384) reject();
  const authURL = new URL(auth);
  if (
    authURL.origin !== b.appOrigin ||
    authURL.pathname !== fixedPath ||
    authURL.hash ||
    authURL.username ||
    authURL.password ||
    [...authURL.searchParams.keys()].length !== 1 ||
    !authURL.searchParams.get(smuggle)
  )
    reject();
  const hostname = await coder.getApplicationsHost();
  if (!hostname || hostname.includes("://") || hostname.split("*").length !== 2) reject();
  const cookieName = `coder_subdomain_app_session_token_${createHash("sha256").update(hostname).digest("hex").slice(0, 32)}`;
  const exchange = await fetchApp(authURL, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    signal: signal(),
    headers: { Accept: "application/json" },
  });
  try {
    boundedHeaders(exchange);
    if (exchange.status !== 303) reject();
    location(exchange, b.appOrigin, fixedPath, false);
    const cookies = exchange.headers.getSetCookie();
    const selected = cookies.filter((c) => c.startsWith(`${cookieName}=`));
    if (selected.length !== 1) reject();
    const cookie = selected[0],
      parts = cookie.split(";").map((p) => p.trim());
    if (
      !parts.some((p) => p.toLowerCase() === "httponly") ||
      !parts.some((p) => p.toLowerCase() === "secure") ||
      !parts.some((p) => p.toLowerCase() === "path=/") ||
      !new RegExp(`^${cookieName}=[A-Za-z0-9_-]{1,512}$`).test(parts[0])
    )
      reject();
    return { cookie: parts[0], url: target, deadline };
  } finally {
    await exchange.body?.cancel().catch(() => {});
  }
}

/** Internal relay only. This secret cookie must never be returned to browsers,
 * logs, URLs or generic fetchers. Caller independently verifies owner/project and
 * active registration; endpoint is fixed to that registered app's /session. */
export async function exchangeVerifiedWorkspaceAppSessionCookie(
  coder: AppAuthCoder,
  binding: AppBinding,
  expiresAt: number,
  fetchApp: typeof fetch = fetch,
) {
  const value = await exchangeAppCookie(coder, binding, "/session", expiresAt, fetchApp);
  return { cookie: value.cookie, url: value.url };
}
/** Terminal relay only: fixed endpoint and request-local scoped cookie. */
export async function exchangeVerifiedWorkspaceAppTerminalCookie(
  coder: AppAuthCoder,
  binding: AppBinding,
  expiresAt: number,
  fetchApp: typeof fetch = fetch,
) {
  const value = await exchangeAppCookie(coder, binding, "/terminal", expiresAt, fetchApp);
  return { cookie: value.cookie, url: value.url };
}
/** Uses only Coder's app-scoped cookie, never owner headers or a general jar. */
export async function postToVerifiedWorkspaceApp(
  coder: AppAuthCoder,
  binding: AppBinding,
  request: { path: HostProjectPath; body: string; expiresAt: number; signal?: AbortSignal },
  fetchApp: typeof fetch = fetch,
) {
  request.signal?.throwIfAborted();
  const scopedFetch: typeof fetch = (input, init) => {
    request.signal?.throwIfAborted();
    return fetchApp(input, {
      ...init,
      ...(request.signal
        ? { signal: AbortSignal.any([request.signal, ...(init?.signal ? [init.signal] : [])]) }
        : {}),
    });
  };
  if (
    ![
      "/registration/bootstrap",
      "/guardian/identity",
      "/guardian/bootstrap",
      "/projects/discover",
      "/projects/resolve",
      "/projects/resolve-ref",
      "/projects/open",
      "/projects/tasks/start",
      "/projects/tasks/status",
      "/projects/tasks/retry",
    ].includes(request.path) ||
    Buffer.byteLength(request.body, "utf8") >
      (request.path === "/projects/tasks/start" ? 98304 : 20000)
  )
    reject();
  const { cookie, url, deadline } = await exchangeAppCookie(
    coder,
    binding,
    request.path,
    request.expiresAt,
    scopedFetch,
  );
  request.signal?.throwIfAborted();
  if (Date.now() >= deadline) reject();
  const response = await scopedFetch(url, {
    method: "POST",
    redirect: "manual",
    credentials: "omit",
    signal: AbortSignal.timeout(deadline - Date.now()),
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: request.body,
  });
  try {
    boundedHeaders(response);
    if (response.status !== 200) reject();
    const result = await boundedJson(
      response,
      request.path === "/projects/discover"
        ? 524288
        : request.path === "/registration/bootstrap"
          ? 4096
          : 16384,
      request.signal,
    );
    request.signal?.throwIfAborted();
    return result;
  } finally {
    if (request.signal) void response.body?.cancel().catch(() => {});
    else await response.body?.cancel().catch(() => {});
  }
}
/** Independent read service only. Fixed path, request-local app cookie, bounded
 * stream lifetime. This does not add an operation to the project dispatcher. */
export async function requestVerifiedWorkspaceRead(
  coder: AppAuthCoder,
  binding: AppBinding,
  request: { ticket: string; expiresAt: number; signal?: AbortSignal },
  fetchApp: typeof fetch = fetch,
): Promise<unknown> {
  const body = JSON.stringify({ ticket: request.ticket });
  if (Buffer.byteLength(body, "utf8") > 786432) reject();
  const remaining = Math.min(10000, request.expiresAt * 1000 - Date.now());
  if (remaining < 1) reject();
  const signal = AbortSignal.any([
    AbortSignal.timeout(remaining),
    ...(request.signal ? [request.signal] : []),
  ]);
  signal.throwIfAborted();
  let rejectStopped!: (reason: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const abort = () => rejectStopped(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const scopedFetch: typeof fetch = (input, init) => {
    signal.throwIfAborted();
    return fetchApp(input, {
      ...init,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    });
  };
  const cancel = async (work: () => Promise<unknown> | undefined) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve()
          .then(work)
          .catch(() => {}),
        new Promise<void>((done) => {
          timer = setTimeout(done, 100);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let response: Response | undefined;
  try {
    const exchange = await Promise.race([
      exchangeAppCookie(coder, binding, "/workspace/read", request.expiresAt, scopedFetch),
      stopped,
    ]);
    signal.throwIfAborted();
    response = await Promise.race([
      scopedFetch(exchange.url, {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Cookie: exchange.cookie },
        body,
      }),
      stopped,
    ]);
    boundedHeaders(response);
    if (response.status !== 200 || response.headers.has("location")) reject();
    const reader = response.body?.getReader();
    if (!reader) reject();
    const chunks: Uint8Array[] = [];
    let bytes = 0,
      count = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const r = await Promise.race([reader.read(), stopped]);
        signal.throwIfAborted();
        if (r.done) break;
        bytes += r.value.byteLength;
        count++;
        if (bytes > 131072 || count > 512) reject();
        chunks.push(r.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await cancel(() => reader.cancel());
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await cancel(() => response?.body?.cancel());
  }
}

/** Fixed owner-only guardian endpoints. No caller-selected app path or headers. */
export async function requestGuardianIdentity(
  coder: AppAuthCoder,
  binding: AppBinding,
  nonce: string,
  fetchApp: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (!/^[a-f0-9]{64}$/.test(nonce)) reject();
  return postToVerifiedWorkspaceApp(
    coder,
    binding,
    {
      path: "/guardian/identity",
      body: JSON.stringify({ nonce }),
      expiresAt: Math.floor(Date.now() / 1000) + 30,
      ...(signal ? { signal } : {}),
    },
    fetchApp,
  );
}
export async function deliverGuardianEnrollment(
  coder: AppAuthCoder,
  binding: AppBinding,
  grant: string,
  fetchApp: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (grant.length < 100 || grant.length > 16384) reject();
  return postToVerifiedWorkspaceApp(
    coder,
    binding,
    {
      path: "/guardian/bootstrap",
      body: JSON.stringify({ grant }),
      expiresAt: Math.floor(Date.now() / 1000) + 30,
      ...(signal ? { signal } : {}),
    },
    fetchApp,
  );
}
export async function deliverRegistrationGrant(
  coder: Parameters<typeof postToVerifiedWorkspaceApp>[0],
  issued: { grant: string; binding: RegistrationBinding; expiresAt: number },
  fetchApp: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (issued.grant.length > 16384) reject();
  const result = await postToVerifiedWorkspaceApp(
    coder,
    issued.binding,
    {
      path: "/registration/bootstrap",
      body: JSON.stringify({ grant: issued.grant }),
      expiresAt: issued.expiresAt,
      ...(signal ? { signal } : {}),
    },
    fetchApp,
  );
  if (
    !result ||
    Object.keys(result).sort().join(",") !== "expiresAt,registrationId" ||
    typeof result.registrationId !== "string" ||
    !Number.isSafeInteger(result.expiresAt)
  )
    reject();
  return { registrationId: result.registrationId as string, expiresAt: result.expiresAt as number };
}
/** Internal controller call only; no public issuance route. Caller authenticates
 * principal and persists projects before invoking. The bearer grant never returns
 * to the browser/model. A failed delivery leaves an unusable durable reservation. */
export async function provisionRegisteredHost(
  authority: WorkspaceRegistrationAuthority,
  coder: Parameters<typeof deliverRegistrationGrant>[0],
  principal: RegistrationPrincipal,
  workspaceId: string,
  agentId: string,
  projectIds: string[],
  options: { signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const issued = await authority.issue(principal, workspaceId, agentId, projectIds);
  options.signal?.throwIfAborted();
  await authority.reauthorize(issued.binding);
  options.signal?.throwIfAborted();
  const fetchApp: typeof fetch = (input, init) => {
    options.signal?.throwIfAborted();
    return fetch(input, {
      ...init,
      ...(options.signal
        ? { signal: AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]) }
        : {}),
    });
  };
  const result = await deliverRegistrationGrant(coder, issued, fetchApp, options.signal);
  options.signal?.throwIfAborted();
  return result;
}
