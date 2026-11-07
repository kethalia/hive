import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ session: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mock.session }));
vi.mock("@/lib/agents/portable-config.server", () => ({
  createPortableAgentService: () => ({ execute: mock.execute }),
}));

import { codexAccountRoute } from "@/lib/agents/codex-account-route.server";

const workspaceId = randomUUID(),
  lifetimeId = randomUUID();
const request = (body: unknown = { action: "status" }, origin = "https://hive.example") =>
  new Request(`https://hive.example/api/workspaces/${workspaceId}/codex-account`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.stubEnv("HIVE_CODEX_ACCOUNTS_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.example");
  mock.session.mockResolvedValue({ user: { id: "hive-owner", coderUserId: "coder-owner" } });
  mock.execute.mockResolvedValue({
    scope: "managed-native",
    lifetimeId,
    generation: 0,
    state: "signed-out",
    pending: null,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("requires explicit gate, exact origin, normal Hive authentication and fixed request shape", async () => {
  vi.stubEnv("HIVE_CODEX_ACCOUNTS_ENABLED", "false");
  expect((await codexAccountRoute(request(), workspaceId)).status).toBe(404);
  vi.stubEnv("HIVE_CODEX_ACCOUNTS_ENABLED", "true");
  expect((await codexAccountRoute(request({}, "https://other.example"), workspaceId)).status).toBe(
    403,
  );
  mock.session.mockResolvedValueOnce(null);
  expect((await codexAccountRoute(request(), workspaceId)).status).toBe(401);
  expect(
    (
      await codexAccountRoute(
        request({ action: "connect", lifetimeId, generation: 0, root: "/home/coder/.codex" }),
        workspaceId,
      )
    ).status,
  ).toBe(409);
  expect(mock.execute).not.toHaveBeenCalled();
});
it("passes only the session principal and managed operation to the bound bridge", async () => {
  const response = await codexAccountRoute(
    request({ action: "connect", lifetimeId, generation: 0 }),
    workspaceId,
  );
  expect(response.status).toBe(200);
  expect(mock.execute).toHaveBeenCalledWith(
    { hiveUserId: "hive-owner", coderUserId: "coder-owner" },
    workspaceId,
    { operation: "codex-account", account: { action: "connect", lifetimeId, generation: 0 } },
    expect.any(AbortSignal),
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("rejects credential-bearing responses and reports cancellation/transport uncertainty honestly", async () => {
  mock.execute.mockResolvedValueOnce({
    scope: "managed-native",
    lifetimeId,
    generation: 1,
    state: "signed-in",
    pending: null,
    accessToken: "secret-fixture",
  });
  const response = await codexAccountRoute(request(), workspaceId);
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("secret-fixture");
  mock.execute.mockRejectedValueOnce(Error("sensitive-provider-response"));
  expect(
    await (
      await codexAccountRoute(
        request({ action: "disconnect", lifetimeId, generation: 1 }),
        workspaceId,
      )
    ).json(),
  ).toEqual({ error: "codex_account_unavailable" });
});
