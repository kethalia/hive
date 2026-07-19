import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";
import { getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { buildWorkspaceUrls } from "@/lib/workspaces/urls";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkspaceMeta {
  fileBrowserBaseUrl: string;
  kasmVncBaseUrl: string;
  allowedHosts: string[];
  expiresAt: number;
}

const MAX_CACHE_SIZE = 100;
const metaCache = new Map<string, WorkspaceMeta>();
const CACHE_TTL_MS = 5 * 60 * 1000;

const APP_SLUG_MAP: Record<string, string> = {
  filebrowser: "filebrowser",
  kasmvnc: "kasm-vnc",
};

const STRIP_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "strict-transport-security",
  "coder-session-token",
]);

const SKIP_REQUEST_HEADERS = new Set([
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

async function getWorkspaceMeta(userId: string, workspaceId: string): Promise<WorkspaceMeta> {
  const cacheKey = `${userId}:${workspaceId}`;
  const cached = metaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const client = await getCoderClientForUser(userId);

  const [workspace, sshTarget, applicationsHost] = await Promise.all([
    client.getWorkspace(workspaceId),
    client.getWorkspaceAgentName(workspaceId),
    client.getApplicationsHost(),
  ]);
  const agentName = sshTarget.includes(".") ? (sshTarget.split(".").pop() ?? sshTarget) : sshTarget;
  const workspaceUrls = buildWorkspaceUrls(
    workspace,
    agentName,
    client.getBaseUrl(),
    applicationsHost,
  );
  if (!workspaceUrls) throw new Error("Coder URL is unavailable for workspace tools");
  const appBaseUrls = [workspaceUrls.filebrowser, workspaceUrls.kasmvnc];

  const meta: WorkspaceMeta = {
    fileBrowserBaseUrl: workspaceUrls.filebrowser,
    kasmVncBaseUrl: workspaceUrls.kasmvnc,
    allowedHosts: [
      new URL(client.getBaseUrl()).host,
      ...appBaseUrls.map((url) => new URL(url).host),
    ],
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  if (metaCache.size >= MAX_CACHE_SIZE) {
    const oldest = metaCache.keys().next().value;
    if (oldest) metaCache.delete(oldest);
  }
  metaCache.set(cacheKey, meta);
  return meta;
}

function resolveApp(pathSegments: string[]): { appSlug: string; subPath: string } {
  const first = pathSegments[0];
  if (first && first in APP_SLUG_MAP) {
    return {
      appSlug: APP_SLUG_MAP[first],
      subPath: pathSegments.slice(1).join("/"),
    };
  }
  return {
    appSlug: "filebrowser",
    subPath: pathSegments.join("/"),
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

function isCoderOrigin(url: URL, allowedHosts: string[]): boolean {
  const targetHost = url.host.toLowerCase();
  return allowedHosts.some((host) => targetHost === host.toLowerCase());
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

async function fetchWithPrivateCoderCa(url: string, init: CoderFetchInit): Promise<Response> {
  const dispatcher = new Agent({
    connect: { rejectUnauthorized: false }, // nosemgrep
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
          await reader.cancel(reason);
          await dispatcher.close();
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
  const [verifiedBody, privateCaBody] = init.body ? init.body.tee() : [undefined, undefined];
  try {
    const verifiedInit: RequestInit & { duplex?: "half" } = {
      method: init.method,
      headers: init.headers,
      body: verifiedBody,
      duplex: verifiedBody ? "half" : undefined,
      redirect: init.redirect,
    };
    const response = await fetch(url, verifiedInit);
    void privateCaBody?.cancel();
    return response;
  } catch (error) {
    if (!isUntrustedCertificateError(error)) {
      void privateCaBody?.cancel(error);
      throw error;
    }
    // Coder installations commonly terminate wildcard workspace-app TLS with a
    // private CA. Retry only after normal verification fails; URL construction
    // and redirect handling still restrict every request to authenticated,
    // explicitly resolved Coder application hosts.
    return fetchWithPrivateCoderCa(url, { ...init, body: privateCaBody });
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

  const session = await getSession(await cookies(), req.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
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

    for (let i = 0; i <= maxRedirects; i++) {
      upstream = await fetchCoderApp(currentUrl, {
        method: i === 0 ? req.method : "GET",
        headers: buildHeaders(currentUrl),
        body: i === 0 ? requestBody : undefined,
        redirect: "manual",
      });

      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get("location");
      if (!location) break;

      const resolvedLocation = new URL(location, currentUrl);

      if (!isCoderOrigin(resolvedLocation, meta.allowedHosts)) {
        break;
      }

      await upstream.body?.cancel();
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

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (location) {
        const locUrl = new URL(location, currentUrl);
        if (isCoderOrigin(locUrl, meta.allowedHosts)) {
          const proxyBase = `/api/workspace-proxy/${workspaceId}`;
          responseHeaders.set("location", `${proxyBase}${locUrl.pathname}${locUrl.search}`);
        } else {
          responseHeaders.set("location", locUrl.toString());
        }
      }
    }

    const contentType = responseHeaders.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");

    if (isHtml && upstream.body) {
      const proxyBase = `/api/workspace-proxy/${workspaceId}`;
      let html = await upstream.text();
      const baseTag = `<base href="${proxyBase}/" />`;
      if (html.includes("<head>")) {
        html = html.replace("<head>", `<head>${baseTag}`);
      } else if (html.includes("<HEAD>")) {
        html = html.replace("<HEAD>", `<HEAD>${baseTag}`);
      } else {
        html = baseTag + html;
      }
      html = html.replace('"BaseURL":""', `"BaseURL":"${proxyBase}/filebrowser"`);
      html = html.replace('"StaticURL":"/static"', `"StaticURL":"${proxyBase}/filebrowser/static"`);
      // eslint-disable-next-line xss/no-mixed-html -- proxyBase contains only a validated UUID.
      html = html.replaceAll('"/static/', `"${proxyBase}/filebrowser/static/`);
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
