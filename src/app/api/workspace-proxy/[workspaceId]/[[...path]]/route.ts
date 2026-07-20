import { createHmac, timingSafeEqual } from "node:crypto";
import { rootCertificates } from "node:tls";
import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";
import { getAuthServiceClient } from "@/lib/auth/service-client";
import { getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { buildWorkspaceUrls } from "@/lib/workspaces/urls";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkspaceMeta {
  fileBrowserBaseUrl: string;
  kasmVncBaseUrl: string;
  allowedOrigins: string[];
  expiresAt: number;
}

const MAX_CACHE_SIZE = 100;
const metaCache = new Map<string, WorkspaceMeta>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const PROXY_GRANT_TTL_MS = 8 * 60 * 60 * 1000;
const PROXY_GRANT_HEADER = "x-hive-workspace-proxy-grant";
const PROXY_PREFLIGHT_HEADERS = new Set([PROXY_GRANT_HEADER, "content-type"]);

const APP_SLUG_MAP: Record<string, string> = {
  filebrowser: "filebrowser",
  kasmvnc: "kasm-vnc",
};

const STRIP_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding",
  "content-length",
  "strict-transport-security",
  "coder-session-token",
]);

const SKIP_REQUEST_HEADERS = new Set([
  PROXY_GRANT_HEADER,
  "host",
  "cookie",
  "connection",
  "referer",
  "origin",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "x-invoke-path",
  "x-invoke-query",
  "x-middleware-invoke",
  "x-nextjs-data",
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-url",
]);

function signProxyGrant(userId: string, sessionId: string, workspaceId: string): string {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) throw new Error("COOKIE_SECRET is not configured");
  const payload = Buffer.from(
    JSON.stringify({ expiresAt: Date.now() + PROXY_GRANT_TTL_MS, sessionId, userId, workspaceId }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyProxyGrant(
  grant: string,
  workspaceId: string,
): { sessionId: string; userId: string } | null {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) return null;
  const separator = grant.indexOf(".");
  if (separator < 1) return null;
  const payload = grant.slice(0, separator);
  const suppliedSignature = grant.slice(separator + 1);
  const expectedSignature = createHmac("sha256", secret).update(payload).digest();
  let suppliedSignatureBytes: Buffer;
  try {
    suppliedSignatureBytes = Buffer.from(suppliedSignature, "base64url");
  } catch {
    return null;
  }
  if (
    suppliedSignatureBytes.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignatureBytes, expectedSignature)
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("expiresAt" in parsed) ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= Date.now() ||
      !("userId" in parsed) ||
      typeof parsed.userId !== "string" ||
      !("sessionId" in parsed) ||
      typeof parsed.sessionId !== "string" ||
      !("workspaceId" in parsed) ||
      parsed.workspaceId !== workspaceId
    ) {
      return null;
    }
    return { sessionId: parsed.sessionId, userId: parsed.userId };
  } catch {
    return null;
  }
}

function setGrantCorsHeaders(headers: Headers): void {
  headers.set("Access-Control-Allow-Origin", "null");
  headers.append("Vary", "Origin");
}

function buildProxyGrantBridge(grant: string, proxyBase: string): string {
  return `<script>(()=>{const g="${grant}",p="${proxyBase}",h="${PROXY_GRANT_HEADER}";const u=i=>{try{const v=new URL(typeof i==="string"?i:i instanceof URL?i.href:i.url,location.href);return v.origin===new URL(location.href).origin&&(v.pathname===p||v.pathname.startsWith(p+"/"))}catch{return false}};const f=window.fetch.bind(window);window.fetch=(i,n={})=>{if(!u(i))return f(i,n);const x=new Headers(n.headers||(i instanceof Request?i.headers:undefined));x.set(h,g);return f(i,{...n,headers:x})};const o=XMLHttpRequest.prototype.open,s=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,url,...r){this.__hiveProxyUrl=new URL(url,location.href).href;return o.call(this,m,url,...r)};XMLHttpRequest.prototype.send=function(body){if(u(this.__hiveProxyUrl))this.setRequestHeader(h,g);return s.call(this,body)}})();</script>`;
}

async function getWorkspaceMeta(userId: string, workspaceId: string): Promise<WorkspaceMeta> {
  const cacheKey = `${userId}:${workspaceId}`;
  const cached = metaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const client = await getCoderClientForUser(userId);

  const [workspace, sshTarget, applicationsHostResult] = await Promise.all([
    client.getWorkspace(workspaceId),
    client.getWorkspaceAgentName(workspaceId),
    client
      .getApplicationsHost()
      .then((host) => ({ host, discovered: true }))
      .catch(() => ({ host: "", discovered: false })),
  ]);
  const agentName = sshTarget.includes(".") ? (sshTarget.split(".").pop() ?? sshTarget) : sshTarget;
  const workspaceUrls = buildWorkspaceUrls(
    workspace,
    agentName,
    client.getBaseUrl(),
    applicationsHostResult.host,
  );
  if (!workspaceUrls) throw new Error("Coder URL is unavailable for workspace tools");
  const appBaseUrls = [workspaceUrls.filebrowser, workspaceUrls.kasmvnc];

  const meta: WorkspaceMeta = {
    fileBrowserBaseUrl: workspaceUrls.filebrowser,
    kasmVncBaseUrl: workspaceUrls.kasmvnc,
    allowedOrigins: [
      new URL(client.getBaseUrl()).origin,
      ...appBaseUrls.map((url) => new URL(url).origin),
    ],
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  if (metaCache.size >= MAX_CACHE_SIZE) {
    const oldest = metaCache.keys().next().value;
    if (oldest) metaCache.delete(oldest);
  }
  if (applicationsHostResult.discovered) metaCache.set(cacheKey, meta);
  return meta;
}

function isSandboxedProxySubresource(req: NextRequest): boolean {
  const referer = req.headers.get("referer");
  if (!referer) return false;
  try {
    const refererUrl = new URL(referer);
    // Sandboxed proxy documents have opaque origins, so Fetch Metadata reports their
    // subresources as cross-site. Browsers control Referer; a Hive-origin referrer proves
    // the request was initiated by content already loaded through this authenticated origin.
    return refererUrl.origin === req.nextUrl.origin;
  } catch {
    return false;
  }
}

function resolveApp(pathSegments: string[]): { appSlug: string; subPath: string } {
  const first = pathSegments[0];
  if (first && first in APP_SLUG_MAP) {
    return {
      appSlug: APP_SLUG_MAP[first],
      subPath: pathSegments.slice(1).map(encodeURIComponent).join("/"),
    };
  }
  return {
    appSlug: "filebrowser",
    subPath: pathSegments.map(encodeURIComponent).join("/"),
  };
}

function buildTargetUrl(
  meta: WorkspaceMeta,
  appSlug: string,
  subPath: string,
  search: string,
): string {
  const base =
    appSlug === "filebrowser"
      ? meta.fileBrowserBaseUrl
      : appSlug === "kasm-vnc"
        ? meta.kasmVncBaseUrl
        : null;
  if (base === null) throw new Error(`Unsupported workspace application: ${appSlug}`);
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${subPath}`;
  url.search = search;
  return url.toString();
}

function isCoderOrigin(url: URL, allowedOrigins: string[]): boolean {
  const targetOrigin = url.origin.toLowerCase();
  return allowedOrigins.some((origin) => targetOrigin === origin.toLowerCase());
}

function isUntrustedCertificateError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
  ) {
    return true;
  }
  if (
    "message" in error &&
    typeof error.message === "string" &&
    /self-signed certificate|unable to verify the first certificate|unable to get local issuer certificate/i.test(
      error.message,
    )
  ) {
    return true;
  }
  return "cause" in error && isUntrustedCertificateError(error.cause);
}

interface CoderFetchInit {
  method: string;
  headers: Headers;
  body?: ReadableStream<Uint8Array>;
  redirect: "manual";
}

async function* streamRequestBody(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchWithConfiguredCoderCa(
  url: string,
  init: CoderFetchInit,
  ca: string,
): Promise<Response> {
  const dispatcher = new Agent({
    connect: { ca: [...rootCertificates, ca] },
  });
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body ? streamRequestBody(init.body) : undefined,
      duplex: init.body ? "half" : undefined,
      redirect: init.redirect,
      dispatcher,
    });
  } catch (retryError) {
    await dispatcher.close();
    throw retryError;
  }
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    headers.set(key, value);
  });
  const reader = response.body?.getReader();
  const body = reader
    ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          let shouldCloseDispatcher = false;
          try {
            const result = await reader.read();
            if (!result.done) {
              controller.enqueue(result.value);
              return;
            }
            shouldCloseDispatcher = true;
            controller.close();
          } catch (error) {
            shouldCloseDispatcher = true;
            controller.error(error);
          } finally {
            if (shouldCloseDispatcher) await dispatcher.close();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await dispatcher.close();
          }
        },
      })
    : null;
  if (body === null) await dispatcher.close();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function fetchCoderApp(url: string, init: CoderFetchInit): Promise<Response> {
  const configuredCa = process.env.CODER_CA_CERT?.trim();
  if (init.body && configuredCa) {
    return fetchWithConfiguredCoderCa(url, init, configuredCa);
  }
  try {
    const verifiedInit: RequestInit & { duplex?: "half" } = {
      method: init.method,
      headers: init.headers,
      body: init.body,
      duplex: init.body ? "half" : undefined,
      redirect: init.redirect,
    };
    return await fetch(url, verifiedInit);
  } catch (error) {
    if (!configuredCa || !isUntrustedCertificateError(error)) throw error;
    return fetchWithConfiguredCoderCa(url, init, configuredCa);
  }
}

async function proxyRequest(
  req: NextRequest,
  params: { workspaceId: string; path?: string[] },
): Promise<NextResponse> {
  const { workspaceId } = params;
  const pathSegments = params.path ?? [];

  if (!UUID_RE.test(workspaceId)) {
    return NextResponse.json({ error: "Invalid workspace ID" }, { status: 400 });
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  const isSandboxedSubresource =
    fetchSite !== null && fetchSite !== "same-origin" && isSandboxedProxySubresource(req);
  if (fetchSite !== null && fetchSite !== "same-origin" && !isSandboxedSubresource) {
    return NextResponse.json(
      { error: "Cross-origin workspace proxy requests are not allowed" },
      {
        status: 403,
        headers: { "Cross-Origin-Resource-Policy": "same-origin" },
      },
    );
  }

  const suppliedGrant = req.headers.get(PROXY_GRANT_HEADER);
  const grantPayload = suppliedGrant ? verifyProxyGrant(suppliedGrant, workspaceId) : null;
  let grantUserId: string | null = null;
  if (grantPayload) {
    const activeSession = await getAuthServiceClient()
      .getSession(grantPayload.sessionId)
      .catch(() => null);
    if (activeSession?.userId === grantPayload.userId) grantUserId = grantPayload.userId;
  }
  if (suppliedGrant && !grantUserId) {
    const response = NextResponse.json({ error: "Invalid workspace proxy grant" }, { status: 401 });
    setGrantCorsHeaders(response.headers);
    return response;
  }
  const session = grantUserId ? null : await getSession(await cookies(), req.headers.get("cookie"));
  if (!grantUserId && !session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = grantUserId ?? session?.user.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let meta: WorkspaceMeta;
  try {
    meta = await getWorkspaceMeta(userId, workspaceId);
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to resolve workspace: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const client = await getCoderClientForUser(userId);
  const sessionToken = client.getSessionToken();
  const { appSlug, subPath } = resolveApp(pathSegments);
  const targetUrl = buildTargetUrl(meta, appSlug, subPath, req.nextUrl.search);

  function buildHeaders(target: string): Headers {
    const h = new Headers();
    h.set("Coder-Session-Token", sessionToken);
    for (const [key, value] of req.headers.entries()) {
      if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      h.set(key, value);
    }
    h.set("Host", new URL(target).host);
    return h;
  }

  try {
    let currentUrl = targetUrl;
    let upstream: Response | undefined;
    const maxRedirects = 5;
    const requestBody = req.body ?? undefined;
    let currentMethod = req.method;
    let currentBody = requestBody;

    for (let i = 0; i <= maxRedirects; i++) {
      upstream = await fetchCoderApp(currentUrl, {
        method: currentMethod,
        headers: buildHeaders(currentUrl),
        body: currentBody,
        redirect: "manual",
      });

      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get("location");
      if (!location) break;

      const resolvedLocation = new URL(location, currentUrl);

      if (!isCoderOrigin(resolvedLocation, meta.allowedOrigins)) {
        break;
      }

      const switchToGet =
        upstream.status === 303 ||
        ((upstream.status === 301 || upstream.status === 302) && currentMethod === "POST");
      if (currentBody && !switchToGet) break;
      await upstream.body?.cancel();
      if (switchToGet) {
        currentMethod = "GET";
        currentBody = undefined;
      }
      currentUrl = resolvedLocation.toString();
    }

    if (!upstream) {
      return NextResponse.json({ error: "No upstream response" }, { status: 502 });
    }

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers.entries()) {
      if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
      responseHeaders.set(key, value);
    }
    if (grantUserId || isSandboxedSubresource) setGrantCorsHeaders(responseHeaders);

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (location) {
        const locUrl = new URL(location, currentUrl);
        if (isCoderOrigin(locUrl, meta.allowedOrigins)) {
          const proxyBase = `/api/workspace-proxy/${workspaceId}`;
          const appPrefix = pathSegments[0] in APP_SLUG_MAP ? `/${pathSegments[0]}` : "";
          responseHeaders.set(
            "location",
            `${proxyBase}${appPrefix}${locUrl.pathname}${locUrl.search}`,
          );
        } else {
          responseHeaders.set("location", locUrl.toString());
        }
      }
    }

    const contentType = responseHeaders.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");

    if (isHtml && upstream.body) {
      const proxyBase = `/api/workspace-proxy/${workspaceId}`;
      const proxyAppSlug = pathSegments[0] in APP_SLUG_MAP ? pathSegments[0] : "filebrowser";
      const appProxyBase = `${proxyBase}/${proxyAppSlug}`;
      let html = await upstream.text();
      const sessionId = grantPayload?.sessionId ?? session?.session.sessionId;
      if (!sessionId) throw new Error("Active Hive session is required for workspace proxy HTML");
      const grantBridge = buildProxyGrantBridge(
        signProxyGrant(userId, sessionId, workspaceId),
        proxyBase,
      );
      const baseTag = `<base href="${appProxyBase}/" />`;
      if (html.includes("<head>")) {
        html = html.replace("<head>", `<head>${baseTag}${grantBridge}`);
      } else if (html.includes("<HEAD>")) {
        html = html.replace("<HEAD>", `<HEAD>${baseTag}${grantBridge}`);
      } else {
        html = baseTag + grantBridge + html;
      }
      if (appSlug === "filebrowser") {
        html = html.replace('"BaseURL":""', `"BaseURL":"${appProxyBase}"`);
        html = html.replace('"StaticURL":"/static"', `"StaticURL":"${appProxyBase}/static"`);
      }
      // eslint-disable-next-line xss/no-mixed-html -- proxyBase contains only a validated UUID.
      html = html.replaceAll('"/static/', `"${appProxyBase}/static/`);
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      return new NextResponse(html, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (e) {
    const detail = e instanceof Error ? `${e.message} (${e.cause ?? "no cause"})` : String(e);
    return NextResponse.json({ error: `Proxy error: ${detail}` }, { status: 502 });
  }
}

type RouteParams = { params: Promise<{ workspaceId: string; path?: string[] }> };

export async function GET(req: NextRequest, { params }: RouteParams) {
  return proxyRequest(req, await params);
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  return proxyRequest(req, await params);
}

export async function PUT(req: NextRequest, { params }: RouteParams) {
  return proxyRequest(req, await params);
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  return proxyRequest(req, await params);
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  return proxyRequest(req, await params);
}

export async function OPTIONS(req: NextRequest, { params }: RouteParams) {
  const { workspaceId } = await params;
  const requestedHeaders =
    req.headers
      .get("access-control-request-headers")
      ?.toLowerCase()
      .split(",")
      .map((header) => header.trim())
      .filter(Boolean) ?? [];
  if (
    !UUID_RE.test(workspaceId) ||
    req.headers.get("origin") !== "null" ||
    !requestedHeaders.includes(PROXY_GRANT_HEADER) ||
    requestedHeaders.some((header) => !PROXY_PREFLIGHT_HEADERS.has(header))
  ) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Headers": requestedHeaders.join(", "),
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Origin": "null",
      "Access-Control-Max-Age": "600",
      Vary: "Origin, Access-Control-Request-Headers",
    },
  });
}
