import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ session: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mock.session }));
vi.mock("@/lib/agents/portable-config.server", () => ({
  createPortableAccountService: () => ({ execute: mock.execute }),
}));

import { codexManagementRoute } from "@/lib/agents/codex-management-route.server";
import { AgentBridgeError } from "@/lib/agents/portable-client.server";

const workspaceId = randomUUID(),
  buildId = randomUUID(),
  lifetimeId = randomUUID();
const request = (action: unknown = { action: "config", lifetimeId, generation: 0 }, extra = {}) =>
  new Request(`https://hive.example/api/workspaces/${workspaceId}/codex-management`, {
    method: "POST",
    headers: { Origin: "https://hive.example", "Content-Type": "application/json" },
    body: JSON.stringify({ buildId, request: action, ...extra }),
  });
const view = {
  scope: "managed-native",
  lifetimeId,
  generation: 0,
  outcome: "read",
  usage: null,
  overridden: null,
  config: {
    version: "version-1",
    values: {
      model: null,
      review_model: null,
      model_reasoning_effort: null,
      model_verbosity: null,
      web_search: null,
      service_tier: null,
    },
    origins: {},
    models: [],
    truncated: false,
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write",
  },
};
beforeEach(() => {
  vi.stubEnv("HIVE_CODEX_ACCOUNTS_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", "https://hive.example");
  mock.session.mockResolvedValue({ user: { id: "hive-owner", coderUserId: "coder-owner" } });
  mock.execute.mockResolvedValue(view);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("uses the existing account gate, session principal, selected build and strict management operation", async () => {
  vi.stubEnv("HIVE_CODEX_ACCOUNTS_ENABLED", "false");
  expect((await codexManagementRoute(request(), workspaceId)).status).toBe(404);
  vi.stubEnv("HIVE_CODEX_ACCOUNTS_ENABLED", "true");
  mock.session.mockResolvedValueOnce(null);
  expect((await codexManagementRoute(request(), workspaceId)).status).toBe(401);
  const response = await codexManagementRoute(request(), workspaceId);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mock.execute).toHaveBeenCalledWith(
    { hiveUserId: "hive-owner", coderUserId: "coder-owner" },
    workspaceId,
    { operation: "codex-management", management: { action: "config", lifetimeId, generation: 0 } },
    expect.any(AbortSignal),
    buildId,
  );
});

it.each([
  { action: "config", lifetimeId, generation: 0, home: "/other" },
  { action: "usage", lifetimeId, generation: 0, method: "thread/start" },
  { action: "config", generation: 0 },
  {
    action: "save-config",
    lifetimeId,
    generation: 0,
    version: "v1",
    values: { sandbox_mode: "danger-full-access" },
  },
  {
    action: "save-config",
    lifetimeId,
    generation: 0,
    version: "v1",
    values: { approval_policy: "never" },
  },
  { action: "save-config", lifetimeId, generation: 0, version: "v1", values: {} },
])("rejects arbitrary authority/methods/settings before transport %j", async (action) => {
  expect((await codexManagementRoute(request(action), workspaceId)).status).toBe(409);
  expect(mock.execute).not.toHaveBeenCalled();
});

it("rejects cross-origin, substituted build/owner envelopes and credential-bearing results", async () => {
  const foreign = request();
  foreign.headers.set("Origin", "https://other.example");
  expect((await codexManagementRoute(foreign, workspaceId)).status).toBe(403);
  expect(
    (await codexManagementRoute(request(undefined, { ownerId: "forged" }), workspaceId)).status,
  ).toBe(409);
  expect(
    (await codexManagementRoute(request(undefined, { buildId: "invalid" }), workspaceId)).status,
  ).toBe(409);
  expect(mock.execute).not.toHaveBeenCalled();
  mock.execute.mockResolvedValueOnce({ ...view, token: "PRIVATE_NATIVE_TOKEN" });
  const response = await codexManagementRoute(request(), workspaceId);
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("PRIVATE_NATIVE_TOKEN");
});

it("distinguishes proven old-runtime capability from temporary failure and never replays a save", async () => {
  mock.execute.mockRejectedValueOnce(new AgentBridgeError("unsupported"));
  const unsupported = await codexManagementRoute(request(), workspaceId);
  expect(unsupported.status).toBe(404);
  expect(await unsupported.json()).toEqual({ error: "codex_management_update_required" });
  mock.execute.mockRejectedValueOnce(new AgentBridgeError("operation_failed"));
  expect((await codexManagementRoute(request(), workspaceId)).status).toBe(409);
  mock.execute.mockClear();
  mock.execute.mockRejectedValueOnce(new AgentBridgeError("outcome_unknown"));
  const failed = await codexManagementRoute(
    request({
      action: "save-config",
      lifetimeId,
      generation: 0,
      version: "version-1",
      values: { model_verbosity: "high" },
    }),
    workspaceId,
  );
  expect(failed.status).toBe(409);
  expect(await failed.json()).toEqual({ error: "codex_management_unavailable" });
  expect(mock.execute).toHaveBeenCalledTimes(1);
});
