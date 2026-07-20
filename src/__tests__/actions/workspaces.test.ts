import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockedAgentClose, mockedAgentOptions, mockedAuthServiceGetSession, mockedUndiciFetch } =
  vi.hoisted(() => ({
    mockedAgentClose: vi.fn(),
    mockedAgentOptions: vi.fn(),
    mockedAuthServiceGetSession: vi.fn(),
    mockedUndiciFetch: vi.fn(),
  }));

vi.mock("undici", () => ({
  Agent: class MockAgent {
    constructor(options: unknown) {
      mockedAgentOptions(options);
    }
    close = mockedAgentClose;
  },
  fetch: mockedUndiciFetch,
}));

vi.mock("@/lib/coder/user-client", () => ({
  getCoderClientForUser: vi.fn(),
}));

vi.mock("@/lib/workspace/exec", () => ({
  execInWorkspace: vi.fn(),
}));

vi.mock("@/lib/workspaces/sessions", () => ({
  parseTmuxSessions: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getRequestSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/lib/auth/service-client", () => ({
  getAuthServiceClient: () => ({ getSession: mockedAuthServiceGetSession }),
}));

import { cookies } from "next/headers";
import { getRequestSession, getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";

const mockedGetCoderClientForUser = vi.mocked(getCoderClientForUser);
const mockedGetRequestSession = vi.mocked(getRequestSession);
const mockedGetSession = vi.mocked(getSession);
const mockedCookies = vi.mocked(cookies);

const MOCK_SESSION = {
  user: {
    id: "user-123",
    coderUrl: "https://coder.example.com",
    coderUserId: "",
    username: "testuser",
    email: "test@example.com",
  },
  session: {
    id: "",
    sessionId: "sess-id-1",
    expiresAt: new Date(Date.now() + 86400000),
  },
};

describe("workspace actions use authActionClient + getCoderClientForUser", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("COOKIE_SECRET", "workspace-proxy-test-secret");
    vi.clearAllMocks();
    mockedUndiciFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    mockedGetRequestSession.mockResolvedValue(MOCK_SESSION);
    mockedGetSession.mockResolvedValue(MOCK_SESSION);
    mockedAuthServiceGetSession.mockResolvedValue({ userId: MOCK_SESSION.user.id });
    mockedCookies.mockResolvedValue({
      get: () => ({ value: "session-cookie-value" }),
    } as never);
  });

  it("workspaces.ts imports authActionClient not actionClient", async () => {
    const source = await readFile("src/lib/actions/workspaces.ts", "utf-8");
    expect(source).toContain("authActionClient");
    expect(source).not.toContain("actionClient.");
    expect(source).not.toContain("getCoderClient()");
  });

  it("workspaces.ts does not reference CODER_URL or CODER_SESSION_TOKEN env vars", async () => {
    const source = await readFile("src/lib/actions/workspaces.ts", "utf-8");
    expect(source).not.toContain("CODER_URL");
    expect(source).not.toContain("CODER_SESSION_TOKEN");
  });

  it("workspaces.ts calls getCoderClientForUser", async () => {
    const source = await readFile("src/lib/actions/workspaces.ts", "utf-8");
    expect(source).toContain("getCoderClientForUser");
    expect(source).toContain("ctx.user.id");
  });

  it("proxy route returns 401 for unauthenticated requests", async () => {
    mockedGetSession.mockResolvedValue(null);

    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const url = "http://localhost/api/workspace-proxy/aaaaaaaa-1111-2222-3333-444444444444";
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({
        workspaceId: "aaaaaaaa-1111-2222-3333-444444444444",
      }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects iframe navigations from a Coder application origin", async () => {
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "abababab-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const req = new Request(url, {
      headers: {
        "Sec-Fetch-Dest": "iframe",
        "Sec-Fetch-Site": "same-site",
      },
    });
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser"] }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(mockedGetCoderClientForUser).not.toHaveBeenCalled();
  });

  it("rejects popup navigations from a Coder application origin", async () => {
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "acacacac-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const req = new Request(url, {
      headers: {
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Site": "same-site",
      },
    });
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser"] }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(mockedGetCoderClientForUser).not.toHaveBeenCalled();
  });

  it("rejects cross-origin subresource mutations before resolving credentials", async () => {
    const { POST } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "adadadad-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser/api/resources`;
    const req = new Request(url, {
      method: "POST",
      body: "upload",
      headers: {
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Site": "same-site",
      },
    });
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await POST(req as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser", "api", "resources"] }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(mockedGetCoderClientForUser).not.toHaveBeenCalled();
  });

  it("allows sandboxed workspace-app subresources with a same-proxy referrer", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("asset", { status: 200 }));
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "aeaeaeae-1111-2222-3333-444444444444";
    const proxyBase = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const url = `${proxyBase}/static/app.js`;
    const req = new Request(url, {
      headers: {
        Referer: `${proxyBase}/files/home/coder`,
        "Sec-Fetch-Dest": "script",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({
        workspaceId,
        path: ["filebrowser", "static", "app.js"],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("authenticates opaque-frame fetches with a signed workspace-scoped grant", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("<html><head></head><body>files</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        new Response('{"items":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const { GET, OPTIONS } = await import(
      "@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route"
    );
    const workspaceId = "bdbdbdbd-1111-2222-3333-444444444444";
    const proxyBase = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const documentRequest = new Request(proxyBase);
    Object.defineProperty(documentRequest, "nextUrl", { value: new URL(proxyBase) });
    const documentResponse = await GET(documentRequest as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser"] }),
    });
    const html = await documentResponse.text();
    const grant = html.match(/const g="([A-Za-z0-9_.-]+)"/)?.[1];
    expect(grant).toBeTruthy();

    const preflightRequest = new Request(`${proxyBase}/api/resources`, {
      method: "OPTIONS",
      headers: {
        Origin: "null",
        "Access-Control-Request-Headers": "content-type, x-hive-workspace-proxy-grant",
        "Access-Control-Request-Method": "GET",
      },
    });
    const preflightResponse = await OPTIONS(preflightRequest as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser", "api", "resources"] }),
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBe("null");
    expect(preflightResponse.headers.get("access-control-allow-headers")).toBe(
      "content-type, x-hive-workspace-proxy-grant",
    );

    mockedGetSession.mockClear();
    const apiUrl = `${proxyBase}/api/resources`;
    const apiRequest = new Request(apiUrl, {
      headers: {
        Origin: "null",
        Referer: proxyBase,
        "Sec-Fetch-Site": "cross-site",
        "x-hive-workspace-proxy-grant": grant ?? "",
      },
    });
    Object.defineProperty(apiRequest, "nextUrl", { value: new URL(apiUrl) });
    const apiResponse = await GET(apiRequest as never, {
      params: Promise.resolve({
        workspaceId,
        path: ["filebrowser", "api", "resources"],
      }),
    });

    expect(apiResponse.status).toBe(200);
    expect(apiResponse.headers.get("access-control-allow-origin")).toBe("null");
    expect(await apiResponse.json()).toEqual({ items: [] });
    expect(mockedGetSession).not.toHaveBeenCalled();
    expect(mockedAuthServiceGetSession).toHaveBeenCalledWith(MOCK_SESSION.session.sessionId);

    mockedAuthServiceGetSession.mockResolvedValueOnce(null);
    const revokedRequest = new Request(apiUrl, {
      headers: {
        Origin: "null",
        Referer: proxyBase,
        "Sec-Fetch-Site": "cross-site",
        "x-hive-workspace-proxy-grant": grant ?? "",
      },
    });
    Object.defineProperty(revokedRequest, "nextUrl", { value: new URL(apiUrl) });
    const revokedResponse = await GET(revokedRequest as never, {
      params: Promise.resolve({
        workspaceId,
        path: ["filebrowser", "api", "resources"],
      }),
    });

    expect(revokedResponse.status).toBe(401);
  });

  it("does not cache fallback app URLs after transient host discovery failure", async () => {
    const getApplicationsHost = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary discovery failure"))
      .mockResolvedValue("*.apps.example.com");
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost,
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "afafafaf-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });
    const routeParams = {
      params: Promise.resolve({ workspaceId, path: ["filebrowser"] }),
    };

    await GET(req as never, routeParams);
    await GET(req as never, routeParams);

    expect(getApplicationsHost).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://filebrowser--main--dev-box--alice.apps.example.com/",
      expect.anything(),
    );
  });

  it("proxy route does not use env var credentials", async () => {
    const source = await readFile(
      "src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts",
      "utf-8",
    );
    expect(source).toContain("getCoderClientForUser");
    expect(source).toContain("getSession");
    expect(source).not.toContain("process.env.CODER_URL");
    expect(source).not.toContain("process.env.CODER_SESSION_TOKEN");
  });

  it("proxy route metaCache key includes userId to prevent cross-user poisoning", async () => {
    const source = await readFile(
      "src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts",
      "utf-8",
    );
    expect(source).toMatch(/\$\{userId\}:\$\{workspaceId\}/);
    expect(source).not.toContain("rejectUnauthorized: false");
  });

  it("falls back to the Coder host when runtime application-host discovery fails", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockRejectedValue(new Error("endpoint unavailable")),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "acacacac-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser"] }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://filebrowser--main--dev-box--alice.coder.example.com/",
      expect.anything(),
    );
  });

  it("proxies workspace apps through Coder's configured wildcard application host", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "bbbbbbbb-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser/files/home`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({
        workspaceId,
        path: ["filebrowser", "files", "home"],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://filebrowser--main--dev-box--alice.apps.example.com/files/home",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("retries private-CA workspace apps through the restricted Coder transport", async () => {
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: { message: "self-signed certificate" },
      }),
    );
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "cccccccc-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser/files/home`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({
        workspaceId,
        path: ["filebrowser", "files", "home"],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(mockedUndiciFetch).toHaveBeenCalledWith(
      "https://filebrowser--main--dev-box--alice.apps.example.com/files/home",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(mockedAgentOptions).toHaveBeenCalledWith({
      connect: { ca: [...rootCertificates, "trusted-private-ca"] },
    });
  });

  it("recognizes local-issuer certificate failures", async () => {
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
      }),
    );
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "eeeeeeee-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser/files/home`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser", "files", "home"] }),
    });

    expect(response.status).toBe(200);
    expect(mockedUndiciFetch).toHaveBeenCalledOnce();
  });

  it("streams File Browser uploads without buffering the request in Hive", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { POST } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "dddddddd-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser/api/resources/home`;
    const req = new Request(url, { method: "POST", body: "streamed-upload" });
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });
    const arrayBufferSpy = vi.spyOn(req, "arrayBuffer");

    const response = await POST(req as never, {
      params: Promise.resolve({
        workspaceId,
        path: ["filebrowser", "api", "resources", "home"],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://filebrowser--main--dev-box--alice.apps.example.com/api/resources/home",
      expect.objectContaining({
        body: expect.any(ReadableStream),
        duplex: "half",
        method: "POST",
      }),
    );
    expect(mockedUndiciFetch).not.toHaveBeenCalled();
    const source = await readFile(
      "src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts",
      "utf-8",
    );
    expect(source).not.toContain(".tee()");
  });

  it("preserves encoded percent signs when reconstructing proxy paths", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "edededed-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser/files/home/100%2520done`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    await GET(req as never, {
      params: Promise.resolve({
        workspaceId,
        path: ["filebrowser", "files", "home", "100%20done"],
      }),
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://filebrowser--main--dev-box--alice.apps.example.com/files/home/100%2520done",
      expect.anything(),
    );
  });

  it("returns body-preserving redirects to the browser without replay buffering", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "/api/resources/canonical" },
      }),
    );
    const { POST } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "fefefefe-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser/api/resources`;
    const req = new Request(url, { method: "POST", body: "upload" });
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await POST(req as never, {
      params: Promise.resolve({
        workspaceId,
        path: ["filebrowser", "api", "resources"],
      }),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `/api/workspace-proxy/${workspaceId}/filebrowser/api/resources/canonical`,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "POST", body: expect.any(ReadableStream) }),
    );
  });

  it("does not follow redirects that downgrade the configured Coder origin", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: "http://filebrowser--main--dev-box--alice.apps.example.com/insecure",
        },
      }),
    );
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "bcbcbcbc-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser"] }),
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://filebrowser--main--dev-box--alice.apps.example.com/insecure",
    );
  });

  it("preserves the KasmVNC app slug on body-replay redirects", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 308, headers: { location: "/api/session/canonical" } }),
    );
    const { POST } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "acacacac-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/kasmvnc/api/session`;
    const req = new Request(url, { method: "POST", body: "mutation" });
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await POST(req as never, {
      params: Promise.resolve({ workspaceId, path: ["kasmvnc", "api", "session"] }),
    });

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      `/api/workspace-proxy/${workspaceId}/kasmvnc/api/session/canonical`,
    );
  });

  it("rewrites KasmVNC HTML assets beneath the KasmVNC proxy prefix", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        '<html><head></head><body><script src="/static/app.js"></script></body></html>',
        {
          status: 200,
          headers: { "content-type": "text/html" },
        },
      ),
    );
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "cdcdcdcd-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/kasmvnc`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["kasmvnc"] }),
    });
    const html = await response.text();

    expect(html).toContain(`<base href="/api/workspace-proxy/${workspaceId}/kasmvnc/" />`);
    expect(html).toContain(`src="/api/workspace-proxy/${workspaceId}/kasmvnc/static/app.js"`);
    expect(html).not.toContain(`${workspaceId}/filebrowser`);
  });

  it("removes stale compression headers from decoded workspace assets", async () => {
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("decoded javascript", {
        status: 200,
        headers: {
          "content-encoding": "gzip",
          "content-length": "8",
          "content-type": "text/javascript",
        },
      }),
    );
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "dededede-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/kasmvnc/static/app.js`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["kasmvnc", "static", "app.js"] }),
    });

    expect(await response.text()).toBe("decoded javascript");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("streams writes through the explicitly configured CA transport", async () => {
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { POST } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "ffffffff-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser/api/resources/home`;
    const req = new Request(url, { method: "POST", body: "streamed-upload" });
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await POST(req as never, {
      params: Promise.resolve({
        workspaceId,
        path: ["filebrowser", "api", "resources", "home"],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedUndiciFetch).toHaveBeenCalledWith(
      "https://filebrowser--main--dev-box--alice.apps.example.com/api/resources/home",
      expect.objectContaining({
        body: expect.objectContaining({ [Symbol.asyncIterator]: expect.any(Function) }),
        duplex: "half",
        method: "POST",
      }),
    );
    expect(mockedAgentOptions).toHaveBeenCalledWith({
      connect: { ca: [...rootCertificates, "trusted-private-ca"] },
    });
  });

  it("closes the private-CA dispatcher before following an allowed redirect", async () => {
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: { message: "self-signed certificate" },
      }),
    );
    mockedUndiciFetch
      .mockResolvedValueOnce(
        new Response("redirect", {
          status: 302,
          headers: { location: "/files/home" },
        }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "abababab-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser"] }),
    });

    expect(response.status).toBe(200);
    expect(mockedUndiciFetch).toHaveBeenCalledTimes(2);
    expect(mockedAgentClose).toHaveBeenCalledOnce();
  });

  it("closes the private-CA dispatcher when streaming the response fails", async () => {
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: { message: "self-signed certificate" },
      }),
    );
    mockedUndiciFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("upstream reset"));
          },
        }),
        { status: 200 },
      ),
    );
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "cdcdcdcd-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser"] }),
    });

    await expect(response.text()).rejects.toThrow("upstream reset");
    expect(mockedAgentClose).toHaveBeenCalledOnce();
  });

  it("closes the private-CA dispatcher when response cancellation fails", async () => {
    vi.stubEnv("CODER_CA_CERT", "trusted-private-ca");
    mockedGetCoderClientForUser.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ name: "dev-box", owner_name: "alice" }),
      getWorkspaceAgentName: vi.fn().mockResolvedValue("dev-box.main"),
      getApplicationsHost: vi.fn().mockResolvedValue("*.apps.example.com"),
      getBaseUrl: () => "https://coder.example.com",
      getSessionToken: () => "coder-session-token",
    } as never);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("fetch failed"), {
        cause: { message: "self-signed certificate" },
      }),
    );
    mockedUndiciFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("cancel failed");
          },
        }),
        { status: 200 },
      ),
    );
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const workspaceId = "edededed-1111-2222-3333-444444444444";
    const url = `http://localhost/api/workspace-proxy/${workspaceId}/filebrowser`;
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({ workspaceId, path: ["filebrowser"] }),
    });

    await expect(response.body?.cancel()).rejects.toThrow("cancel failed");
    expect(mockedAgentClose).toHaveBeenCalled();
  });
});
