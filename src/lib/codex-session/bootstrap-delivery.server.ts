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
async function boundedJson(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) reject();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > limit) reject();
      chunks.push(r.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
/** Uses only Coder's app-scoped cookie. No general cookie jar, automatic redirect,
 * caller URL, Authorization header, or owner token reaches the workspace app.
 * Inject fetch only for fixtures/platform transport; production uses native fetch.
 */
export async function postToVerifiedWorkspaceApp(
  coder: Pick<CoderClient, "getApplicationAuthRedirect" | "getApplicationsHost" | "getBaseUrl">,
  binding: Pick<RegistrationBinding, "coderOrigin" | "appOrigin">,
  request: {
    path: "/registration/bootstrap" | "/projects/discover";
    body: string;
    expiresAt: number;
  },
  fetchApp: typeof fetch = fetch,
) {
  const b = binding,
    origin = new URL(b.appOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== b.appOrigin ||
    origin.username ||
    origin.password ||
    coder.getBaseUrl() !== b.coderOrigin ||
    request.body.length > 20000
  )
    reject();
  if (!["/registration/bootstrap", "/projects/discover"].includes(request.path)) reject();
  const fixedPath = request.path;
  const remaining = request.expiresAt * 1000 - Date.now();
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
    // Domain may cover other workspace apps. Deliberately ignore jar semantics:
    // this one cookie is sent only to the exact independently verified app origin.
    const response = await fetchApp(target, {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      signal: signal(),
      headers: { "Content-Type": "application/json", Cookie: parts[0] },
      body: request.body,
    });
    try {
      boundedHeaders(response);
      if (response.status !== 200) reject();
      return await boundedJson(response, fixedPath === "/projects/discover" ? 524288 : 4096);
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  } finally {
    await exchange.body?.cancel().catch(() => {});
  }
}
export async function deliverRegistrationGrant(
  coder: Parameters<typeof postToVerifiedWorkspaceApp>[0],
  issued: { grant: string; binding: RegistrationBinding; expiresAt: number },
  fetchApp: typeof fetch = fetch,
) {
  if (issued.grant.length > 16384) reject();
  const result = await postToVerifiedWorkspaceApp(
    coder,
    issued.binding,
    {
      path: "/registration/bootstrap",
      body: JSON.stringify({ grant: issued.grant }),
      expiresAt: issued.expiresAt,
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
) {
  const issued = await authority.issue(principal, workspaceId, agentId, projectIds);
  await authority.reauthorize(issued.binding);
  return deliverRegistrationGrant(coder, issued);
}
