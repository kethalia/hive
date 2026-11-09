import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { normalizeAppPath } from "next/dist/shared/lib/router/utils/app-paths";
import { getSortedRoutes } from "next/dist/shared/lib/router/utils/sorted-routes";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/agents/portable-config.server", () => ({
  createPortableAccountService: () => ({ execute: mocks.execute }),
}));

import { POST as claudePost } from "@/app/api/workspaces/[workspaceId]/claude-account/route";
import { POST as codexPost } from "@/app/api/workspaces/[workspaceId]/codex-account/route";
import { proxy } from "@/proxy";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const origin = "https://hive.example";
const endpoint = (name: string) => `/api/workspaces/${workspaceId}/${name}`;
const request = (path: string, method = "POST", cookie = "") =>
  new NextRequest(`${origin}${path}`, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ action: "status" }) } : {}),
  });

beforeEach(() => {
  vi.stubEnv("HIVE_CODEX_ACCOUNTS_ENABLED", "true");
  vi.stubEnv("HIVE_CLAUDE_ACCOUNTS_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
  mocks.session.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("constructs Next's dynamic matcher from every repository app route and page", () => {
  const root = join(process.cwd(), "src/app");
  const paths: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (/^(?:page|route)\.(?:ts|tsx|js|jsx)$/.test(entry.name))
        paths.push(
          normalizeAppPath(
            `/${relative(root, path)
              .split(sep)
              .join("/")
              .replace(/\.[^.]+$/, "")}`,
          ),
        );
    }
  };
  collect(root);
  expect(paths).toContain("/api/workspaces/[workspaceId]/codex-account");
  expect(paths).toContain("/api/workspaces/[workspaceId]/claude-account");
  expect(paths).toContain("/api/workspaces/[workspaceId]/voice");
  expect(() => getSortedRoutes(paths)).not.toThrow();
  // The same installed Next implementation rejects the old sibling shape.
  expect(() =>
    getSortedRoutes(["/api/workspaces/[id]/codex-account", "/api/workspaces/[workspaceId]/voice"]),
  ).toThrow("different slug names");
});

it.each([
  ["codex-account", codexPost],
  ["claude-account", claudePost],
] as const)("returns a private JSON401 through proxy and the real %s wrapper", async (name, handler) => {
  for (const cookie of ["", "hive_session=expired"]) {
    const input = request(endpoint(name), "POST", cookie);
    const gate = proxy(input);
    expect(gate.headers.get("x-middleware-next")).toBe("1");
    expect(gate.headers.has("location")).toBe(false);
    const response = await handler(input, { params: Promise.resolve({ workspaceId }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not_authenticated" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  }
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("lets the exact maintenance POST reach its own owner-session gate", () => {
  const response = proxy(request(endpoint("account-maintenance")));
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.headers.has("location")).toBe(false);
});

it.each([
  [endpoint("codex-account"), "GET"],
  [endpoint("claude-account"), "PUT"],
  [endpoint("account-maintenance"), "GET"],
  [endpoint("Codex-account"), "POST"],
  [endpoint("codex-account/extra"), "POST"],
  [endpoint("other-account"), "POST"],
  ["/api/workspaces/not-a-uuid/codex-account", "POST"],
  [endpoint("voice"), "POST"],
])("keeps the middleware session gate for %s %s", (path, method) => {
  const response = proxy(request(path, method));
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(`${origin}/login`);
});

it("preserves route-owned feature, origin and UUID checks before any provider call", async () => {
  vi.stubEnv("HIVE_CODEX_ACCOUNTS_ENABLED", "false");
  expect(
    (
      await codexPost(request(endpoint("codex-account")), {
        params: Promise.resolve({ workspaceId }),
      })
    ).status,
  ).toBe(404);
  vi.stubEnv("HIVE_CODEX_ACCOUNTS_ENABLED", "true");
  const foreign = request(endpoint("codex-account"));
  foreign.headers.set("Origin", "https://other.example");
  expect((await codexPost(foreign, { params: Promise.resolve({ workspaceId }) })).status).toBe(403);
  expect(
    (
      await codexPost(request(endpoint("codex-account")), {
        params: Promise.resolve({ workspaceId: "bad" }),
      })
    ).status,
  ).toBe(400);
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
