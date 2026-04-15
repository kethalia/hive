import { NextRequest, NextResponse } from "next/server";
import { CoderClient } from "@/lib/coder/client";

interface WorkspaceMeta {
  owner: string;
  name: string;
  agent: string;
  expiresAt: number;
}

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
]);

const SKIP_REQUEST_HEADERS = new Set([
  "host", "cookie", "connection", "referer", "origin",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port", "x-real-ip", "x-invoke-path", "x-invoke-query",
  "x-middleware-invoke", "x-nextjs-data", "rsc", "next-router-state-tree",
  "next-router-prefetch", "next-url",
]);

async function getWorkspaceMeta(workspaceId: string): Promise<WorkspaceMeta> {
  const cached = metaCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const client = new CoderClient({
    baseUrl: process.env.CODER_URL!,
    sessionToken: process.env.CODER_SESSION_TOKEN!,
  });

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
  metaCache.set(workspaceId, meta);
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
  // Unknown first segment — default to filebrowser.
  // This handles Coder-injected assets that use relative paths
  // resolving outside the app prefix (e.g. ../assets/ui.js).
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
  const coderUrl = process.env.CODER_URL!;
  const coderHost = coderUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const base = `https://${appSlug}--${meta.agent}--${meta.name}--${meta.owner}.${coderHost}`;
  return `${base}/${subPath}${search}`;
}

async function proxyRequest(
  req: NextRequest,
  params: { workspaceId: string; path?: string[] },
): Promise<NextResponse> {
  const { workspaceId } = params;
  const pathSegments = params.path ?? [];

  if (!process.env.CODER_URL || !process.env.CODER_SESSION_TOKEN) {
    return NextResponse.json(
      { error: "CODER_URL and CODER_SESSION_TOKEN must be configured" },
      { status: 500 },
    );
  }

  let meta: WorkspaceMeta;
  try {
    meta = await getWorkspaceMeta(workspaceId);
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to resolve workspace: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const { appSlug, subPath } = resolveApp(pathSegments);
  const targetUrl = buildTargetUrl(meta, appSlug, subPath, req.nextUrl.search);
  const sessionToken = process.env.CODER_SESSION_TOKEN!;

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
      currentUrl = new URL(location, currentUrl).toString();
    }

    const responseHeaders = new Headers();
    for (const [key, value] of upstream!.headers.entries()) {
      if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
      responseHeaders.set(key, value);
    }

    const appHost = new URL(targetUrl).host;
    if (upstream!.status >= 300 && upstream!.status < 400) {
      const location = upstream!.headers.get("location");
      if (location) {
        const locUrl = new URL(location, currentUrl);
        if (locUrl.host === appHost) {
          const proxyBase = `/api/workspace-proxy/${workspaceId}`;
          responseHeaders.set("location", `${proxyBase}${locUrl.pathname}${locUrl.search}`);
        }
      }
    }

    const contentType = responseHeaders.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");

    if (isHtml && upstream!.body) {
      const proxyBase = `/api/workspace-proxy/${workspaceId}`;
      let html = await upstream!.text();
      // Rewrite absolute paths in HTML attributes
      html = html.replace(
        /(src|href|action)="\/(?!\/)/g,
        `$1="${proxyBase}/`,
      );
      // Inject proxy base into filebrowser's runtime config
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
      { error: `Proxy error: ${detail}`, targetUrl },
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
