import { afterEach, describe, expect, it, vi } from "vitest";

const mockVerifyCookie = vi.hoisted(() => vi.fn());

vi.mock("@hive/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hive/auth")>()),
  verifyCookie: (...args: unknown[]) => mockVerifyCookie(...args),
}));

import { NextRequest } from "next/server";
import { proxy } from "../proxy";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("proxy", () => {
  it("requires all acceptance capability flags and bounds the exact callback transport", () => {
    vi.stubEnv("HIVE_CODEX_GATEWAY_ENABLED", "true");
    const names = [
      "HIVE_DELIVERY_MANAGER_ENABLED",
      "HIVE_DELIVERY_EXECUTION_ENABLED",
      "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
      "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
    ];
    const url = "https://hive.example/api/delivery/host/acceptance";
    const request = (length = "262144", headers = {}) =>
      new NextRequest(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": length, ...headers },
      });
    for (const name of names) vi.stubEnv(name, "true");
    expect(proxy(request()).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("262145")).headers.get("location")).toBe("https://hive.example/login");
    expect(proxy(request("100", { Origin: "https://hive.example" })).headers.get("location")).toBe(
      "https://hive.example/login",
    );
    for (const name of names) {
      vi.stubEnv(name, "false");
      expect(proxy(request()).headers.get("location")).toBe("https://hive.example/login");
      vi.stubEnv(name, "true");
    }
  });
  it("passes only exact project API methods to their route-owned JSON authentication", () => {
    const origin = "https://hive.example";
    const project = "/api/projects/22222222-2222-4222-8222-222222222222";
    for (const [path, method] of [
      ["/api/projects", "GET"],
      ["/api/projects/open", "POST"],
      [`${project}/session-grant`, "POST"],
      [`${project}/terminal-grant`, "POST"],
      [`${project}/tasks/start`, "POST"],
      [`${project}/tasks/retry`, "POST"],
      [`${project}/tasks/status`, "POST"],
    ]) {
      const result = proxy(new NextRequest(`${origin}${path}`, { method }));
      expect(result.headers.get("x-middleware-next")).toBe("1");
      expect(result.headers.get("location")).toBeNull();
    }
    for (const [path, method] of [
      ["/api/projects", "POST"],
      ["/api/projects/open", "GET"],
      ["/api/projects/open/extra", "POST"],
      ["/api/projects/%6fpen", "POST"],
      [`${project}/session-grant`, "GET"],
      [`${project}/terminal-grant/extra`, "POST"],
      [`${project}/tasks/start`, "GET"],
      [`${project}/tasks/status`, "GET"],
      ["/api/projects/not-a-uuid/tasks/status", "GET"],
    ]) {
      expect(proxy(new NextRequest(`${origin}${path}`, { method })).headers.get("location")).toBe(
        `${origin}/login`,
      );
    }
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });
  it("routes enabled host delivery callbacks to signature authentication without browser authority", () => {
    for (const name of [
      "HIVE_CODEX_GATEWAY_ENABLED",
      "HIVE_GUARDIAN_ENABLED",
      "HIVE_DELIVERY_MANAGER_ENABLED",
      "HIVE_DELIVERY_NATIVE_ENABLED",
      "HIVE_DELIVERY_GITHUB_SOURCE_ENABLED",
      "HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED",
    ])
      vi.stubEnv(name, "true");
    const origin = "https://hive.example";
    for (const path of [
      "/api/codex-host/guardians",
      "/api/delivery/host",
      "/api/delivery/native",
      "/api/delivery/github-source",
      "/api/delivery/source-publication/state",
    ]) {
      const request = (suffix = "", headers = {}) =>
        new NextRequest(`${origin}${path}${suffix}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
        });
      expect(proxy(request()).headers.get("x-middleware-next")).toBe("1");
      expect(proxy(request("", { Origin: origin })).headers.get("location")).toBe(
        `${origin}/login`,
      );
      expect(proxy(request("?unexpected=1")).headers.get("location")).toBe(`${origin}/login`);
      expect(proxy(request("/extra")).headers.get("location")).toBe(`${origin}/login`);
    }
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });
  it("routes only exact delivery reads and pause POSTs to their session handlers", () => {
    const origin = "https://hive.example";
    const task = "/api/delivery/tasks/22222222-2222-4222-8222-222222222222";
    for (const [path, method] of [
      ["/api/delivery/tasks", "GET"],
      [task, "GET"],
      [`${task}/pause`, "POST"],
    ]) {
      expect(
        proxy(new NextRequest(`${origin}${path}`, { method })).headers.get("x-middleware-next"),
      ).toBe("1");
    }
    for (const [path, method] of [
      ["/api/delivery/tasks", "POST"],
      [task, "POST"],
      [`${task}/pause`, "GET"],
      [`${task}/pause/other`, "POST"],
      ["/api/delivery/host", "POST"],
    ]) {
      expect(proxy(new NextRequest(`${origin}${path}`, { method })).headers.get("location")).toBe(
        `${origin}/login`,
      );
    }
  });
  it("passes only the exact Settings GET to its route-owned JSON authentication", () => {
    const origin = "https://hive.example";
    const response = proxy(new NextRequest(`${origin}/api/settings/window`));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
    for (const [path, method] of [
      ["/api/settings/window", "POST"],
      ["/api/settings/window", "HEAD"],
      ["/api/settings/window/other", "GET"],
      ["/api/settings/window-extra", "GET"],
      ["/api/settings/%77indow", "GET"],
    ]) {
      expect(proxy(new NextRequest(`${origin}${path}`, { method })).headers.get("location")).toBe(
        `${origin}/login`,
      );
    }
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });
  it("passes only enabled exact native callback POSTs to their own signature handlers", () => {
    const origin = "https://hive.local.kethalia.com";
    const registration = "/api/codex-host/registrations";
    const heartbeat = `${registration}/00000000-0000-4000-8000-000000000001/heartbeat`;
    const request = (path: string, method = "POST", extra: Record<string, string> = {}) =>
      new NextRequest(`${origin}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...extra },
      });
    vi.stubEnv("HIVE_CODEX_GATEWAY_ENABLED", "false");
    expect(proxy(request(registration)).headers.get("location")).toBe(`${origin}/login`);
    vi.stubEnv("HIVE_CODEX_GATEWAY_ENABLED", "true");
    for (const path of [registration, heartbeat]) {
      const response = proxy(request(path));
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-security-policy")).not.toBeNull();
    }
    for (const invalid of [
      request(registration, "GET"),
      request(`${registration}?invalid=1`),
      request("/api/codex-host/%72egistrations"),
      request("/api/projects", "POST"),
      request(registration, "POST", { Origin: origin }),
    ])
      expect(proxy(invalid).headers.get("location")).toBe(`${origin}/login`);
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });
  it("keeps the marketing homepage public without exposing dashboard routes", () => {
    const homepageResponse = proxy(new NextRequest("https://hive.local.kethalia.com/"));
    const dashboardResponse = proxy(new NextRequest("https://hive.local.kethalia.com/workspaces"));

    expect(homepageResponse.headers.get("location")).toBeNull();
    expect(
      homepageResponse.headers.get("x-middleware-request-x-hive-coder-frame-hosts"),
    ).toBeNull();
    expect(dashboardResponse.headers.get("location")).toBe("https://hive.local.kethalia.com/login");
  });

  it("refreshes a valid session cookie onto COOKIE_DOMAIN", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    vi.stubEnv("COOKIE_DOMAIN", ".hive.local.kethalia.com");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.local.kethalia.com/templates", {
      headers: {
        cookie: "hive-session=signed-value; hive-coder-host=coder.example.com~apps.coder.test",
      },
    });

    const response = proxy(request);
    const setCookie = response.headers.get("set-cookie");

    expect(mockVerifyCookie).toHaveBeenCalledWith("signed-value", "test-secret");
    expect(setCookie).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-src 'self' https://coder.example.com https://*.coder.example.com",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "https://apps.coder.test https://*.apps.coder.test",
    );
    expect(response.headers.get("content-security-policy")).not.toContain(
      "frame-src 'self' https:;",
    );
    expect(response.headers.get("permissions-policy")).toContain(
      'clipboard-read=(self "https://coder.example.com" "https://*.coder.example.com"',
    );
    expect(response.headers.get("permissions-policy")).toContain(
      '"https://apps.coder.test" "https://*.apps.coder.test")',
    );
    expect(response.headers.get("x-middleware-request-x-hive-coder-frame-hosts")).toBe(
      "https://coder.example.com~https://apps.coder.test",
    );

    vi.unstubAllEnvs();
  });

  it("allows workspace applications beneath an apex Coder application host", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.example.com/workspaces", {
      headers: { cookie: "hive-session=signed-value; hive-coder-host=example.com" },
    });

    expect(proxy(request).headers.get("content-security-policy")).toContain(
      "https://example.com https://*.example.com",
    );
  });

  it("allows workspace applications beneath a suffix-style Coder application host", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });

    const request = new NextRequest("https://hive.example.com/workspaces", {
      headers: { cookie: "hive-session=signed-value; hive-coder-host=*--suffix.au.example.com" },
    });
    const policy = proxy(request).headers.get("content-security-policy") ?? "";

    expect(policy).toContain("https://*.au.example.com");
    expect(policy).not.toContain("https://*.*--suffix.au.example.com");
  });

  it("preserves HTTP frame sources stored for a non-TLS Coder deployment", () => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "sess-123", timestamp: Date.now() });
    const frameSources = encodeURIComponent("http://localhost:7080~http://apps.localhost:7080");
    const request = new NextRequest("http://localhost:3000/workspaces", {
      headers: { cookie: `hive-session=signed-value; hive-coder-host=${frameSources}` },
    });

    const policy = proxy(request).headers.get("content-security-policy") ?? "";
    expect(policy).toContain("http://localhost:7080 http://*.localhost:7080");
    expect(policy).toContain("http://apps.localhost:7080 http://*.apps.localhost:7080");
  });

  it.each([
    "hive-session=victim; hive-session=attacker",
    "hive-session=attacker; hive-session=victim",
    "hive-session=same; hive-session=same",
    "hive-session=; hive-session=victim",
  ])("rejects ambiguous cookies without selecting by browser order or timestamp: %s", (cookie) => {
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "attacker", timestamp: Date.now() });
    const response = proxy(
      new NextRequest("https://hive.example.com/workspaces", { headers: { cookie } }),
    );
    expect(response.headers.get("location")).toBe("https://hive.example.com/login");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });

  it("requires a fresh production login instead of trusting a legacy domain cookie", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    const response = proxy(
      new NextRequest("https://hive.example.com/workspaces", {
        headers: { cookie: "hive-session=legacy-valid" },
      }),
    );
    expect(response.headers.get("location")).toBe("https://hive.example.com/login");
    expect(mockVerifyCookie).not.toHaveBeenCalled();
  });

  it("uses the protected cookie even alongside attacker-planted legacy cookies", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_SECRET", "test-secret");
    mockVerifyCookie.mockReturnValue({ sessionId: "victim", timestamp: Date.now() });
    const response = proxy(
      new NextRequest("https://hive.example.com/workspaces", {
        headers: {
          cookie: "hive-session=attacker; __Host-hive-session=victim; hive-session=another",
        },
      }),
    );
    expect(response.headers.get("location")).toBeNull();
    expect(mockVerifyCookie).toHaveBeenCalledOnce();
    expect(mockVerifyCookie).toHaveBeenCalledWith("victim", "test-secret");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

it("lets discovery routes return their own JSON authentication errors instead of login HTML", () => {
  const response = proxy(new NextRequest("https://hive.example/api/discovery/workspaces"));
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-middleware-next")).toBe("1");
});
