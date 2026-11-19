import { createHash } from "node:crypto";
import type { CoderClient } from "@/lib/coder/client";
import type { AgentBridgeBinding } from "./portable-contracts";

type AppAuthCoder = Pick<
  CoderClient,
  "getBaseUrl" | "getApplicationAuthRedirect" | "getApplicationsHost"
>;
type AppBinding = AgentBridgeBinding;

const smuggle = "coder_application_connect_api_key_35e783";

function reject(): never {
  throw new Error("Workspace app transport unavailable or changed.");
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
async function exchangeAppCookie(
  coder: AppAuthCoder,
  binding: AppBinding,
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
  const fixedPath = "/agent/operation";
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

export async function requestVerifiedWorkspaceAgent(
  coder: AppAuthCoder,
  binding: AppBinding,
  request: { ticket: string; expiresAt: number; signal: AbortSignal },
  fetchApp: typeof fetch = fetch,
): Promise<Response> {
  const body = JSON.stringify({ ticket: request.ticket });
  if (Buffer.byteLength(body, "utf8") > 16384) reject();
  request.signal.throwIfAborted();
  const scopedFetch: typeof fetch = (input, init) =>
    fetchApp(input, {
      ...init,
      signal: AbortSignal.any([request.signal, ...(init?.signal ? [init.signal] : [])]),
    });
  const { cookie, url } = await exchangeAppCookie(coder, binding, request.expiresAt, scopedFetch);
  request.signal.throwIfAborted();
  const response = await scopedFetch(url, {
    method: "POST",
    redirect: "manual",
    credentials: "omit",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body,
  });
  try {
    boundedHeaders(response);
  } catch (error) {
    void response.body?.cancel().catch(() => {});
    throw error;
  }
  return response;
}
