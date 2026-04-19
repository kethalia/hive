import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WorkspaceMeta {
  owner: string;
  name: string;
  agent: string;
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
  "host", "cookie", "connection", "referer", "origin",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port", "x-real-ip", "x-invoke-path", "x-invoke-query",
  "x-middleware-invoke", "x-nextjs-data", "rsc", "next-router-state-tree",
  "next-router-prefetch", "next-url",
]);

async function getWorkspaceMeta(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMeta> {
  const cacheKey = `${userId}:${workspaceId}`;
  const cached = metaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const client = await getCoderClientForUser(userId);

  const workspace = await client.getWorkspace(workspaceId);
  const sshTarget = await client.getWorkspaceAgentName(workspaceId);
  const agentName = sshTarget.includes(".")
    ? sshTarget.split(".").pop()!
    : sshTarget;

  const meta: WorkspaceMeta = {
    owner: workspace.owner_name,
    name: workspace.name,
    agent: agentName,
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
  coderHost: string,
  meta: WorkspaceMeta,
  appSlug: string,
  subPath: string,
  search: string,
): string {
  const base = `https://${appSlug}--${meta.agent}--${meta.name}--${meta.owner}.${coderHost}`;
  return `${base}/${subPath}${search}`;
}

function isCoderOrigin(url: URL, coderHost: string): boolean {
  const targetHost = url.host.toLowerCase();
  const lowerCoderHost = coderHost.toLowerCase();
  return targetHost === lowerCoderHost || targetHost.endsWith(`.${lowerCoderHost}`);
}

async function proxyRequest(
  req: NextRequest,
  params: { workspaceId: string; path?: string[] },
): Promise<NextResponse> {
  const { workspaceId } = params;
  const pathSegments = params.path ?? [];

  if (!UUID_RE.test(workspaceId)) {
    return NextResponse.json(
      { error: "Invalid workspace ID" },
      { status: 400 },
    );
  }

  const session = await getSession(await cookies());
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const userId = session.user.id;
  const coderHost = session.user.coderUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  let meta: WorkspaceMeta;
  try {
    meta = await getWorkspaceMeta(userId, workspaceId);
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to resolve workspace: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const { appSlug, subPath } = resolveApp(pathSegments);
  const targetUrl = buildTargetUrl(coderHost, meta, appSlug, subPath, req.nextUrl.search);

  const client = await getCoderClientForUser(userId);
  const sessionToken = client.getSessionToken();

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

    for (let i = 0; i <= maxRedirects; i++) {
      upstream = await fetch(currentUrl, {
        method: i === 0 ? req.method : "GET",
        headers: buildHeaders(currentUrl),
        body: i === 0 && req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        redirect: "manual",
      });

      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get("location");
      if (!location) break;

      const resolvedLocation = new URL(location, currentUrl);

      if (!isCoderOrigin(resolvedLocation, coderHost)) {
        break;
      }

      currentUrl = resolvedLocation.toString();
    }

    const responseHeaders = new Headers();
    for (const [key, value] of upstream!.headers.entries()) {
      if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
      responseHeaders.set(key, value);
    }

    if (upstream!.status >= 300 && upstream!.status < 400) {
      const location = upstream!.headers.get("location");
      if (location) {
        const locUrl = new URL(location, currentUrl);
        if (isCoderOrigin(locUrl, coderHost)) {
          const proxyBase = `/api/workspace-proxy/${workspaceId}`;
          responseHeaders.set("location", `${proxyBase}${locUrl.pathname}${locUrl.search}`);
        } else {
          responseHeaders.set("location", locUrl.toString());
        }
      }
    }

    const contentType = responseHeaders.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");

    if (isHtml && upstream!.body) {
      const proxyBase = `/api/workspace-proxy/${workspaceId}`;
      let html = await upstream!.text();
      const baseTag = `<base href="${proxyBase}/" />`;
      if (html.includes("<head>")) {
        html = html.replace("<head>", `<head>${baseTag}`);
      } else if (html.includes("<HEAD>")) {
        html = html.replace("<HEAD>", `<HEAD>${baseTag}`);
      } else {
        html = baseTag + html;
      }
      html = html.replace(
        '"BaseURL":""',
        `"BaseURL":"${proxyBase}/filebrowser"`,
      );
      html = html.replace(
        '"StaticURL":"/static"',
        `"StaticURL":"${proxyBase}/filebrowser/static"`,
      );
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      return new NextResponse(html, {
        status: upstream!.status,
        statusText: upstream!.statusText,
        headers: responseHeaders,
      });
    }

    return new NextResponse(upstream!.body, {
      status: upstream!.status,
      statusText: upstream!.statusText,
      headers: responseHeaders,
    });
  } catch (e) {
    const detail = e instanceof Error ? `${e.message} (${e.cause ?? "no cause"})` : String(e);
    return NextResponse.json(
      { error: `Proxy error: ${detail}` },
      { status: 502 },
    );
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
