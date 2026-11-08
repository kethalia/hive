import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ session: vi.fn(), execute: vi.fn(), slots: vi.fn() }));
vi.mock("@hive/db", () => ({ getDb: () => ({ codexHostSlot: { findMany: mock.slots } }) }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mock.session }));
vi.mock("@/lib/agents/portable-config.server", () => ({
  createPortableAccountService: () => ({ execute: mock.execute }),
}));

import { claudeAccountRoute, codexAccountRoute } from "@/lib/agents/codex-account-route.server";

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
  mock.session.mockResolvedValue({
    user: { id: "hive-owner", coderUserId: "coder-owner", coderUrl: "https://coder.example" },
  });
  mock.slots.mockResolvedValue([]);
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

it("Claude code input is separately gated, exact-shaped, and never echoed", async () => {
  expect((await claudeAccountRoute(request(), workspaceId)).status).toBe(404);
  vi.stubEnv("HIVE_CLAUDE_ACCOUNTS_ENABLED", "true");
  expect(
    (
      await claudeAccountRoute(
        request({ action: "code", lifetimeId, generation: 1, code: "line1\nline2" }),
        workspaceId,
      )
    ).status,
  ).toBe(409);
  expect(mock.execute).not.toHaveBeenCalled();
  mock.execute.mockResolvedValue({
    scope: "workspace-cli",
    lifetimeId,
    generation: 2,
    state: "pending",
    pending: {
      verificationUrl: "https://claude.com/cai/oauth/authorize?state=fixture",
      codeSubmitted: true,
      expiresAt: Date.now() + 600000,
    },
  });
  const response = await claudeAccountRoute(
    request({ action: "code", lifetimeId, generation: 1, code: "PRIVATE_CODE#STATE" }),
    workspaceId,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("PRIVATE_CODE");
  expect(mock.execute).toHaveBeenCalledWith(
    { hiveUserId: "hive-owner", coderUserId: "coder-owner" },
    workspaceId,
    {
      operation: "claude-account",
      account: { action: "code", lifetimeId, generation: 1, code: "PRIVATE_CODE#STATE" },
    },
    expect.any(AbortSignal),
  );
});

it("pending maintenance permits cached status and exact cancellation but no new auth mutation", async () => {
  const id = randomUUID(),
    buildId = randomUUID();
  mock.slots.mockResolvedValue([
    {
      accountMaintenance: {
        schemaVersion: 1,
        purpose: "account-maintenance",
        id,
        ownerId: randomUUID(),
        coderOwnerId: randomUUID(),
        coderOrigin: "https://coder.example",
        workspaceId,
        buildId,
        phase: "requested",
        requestedAt: new Date().toISOString(),
        runtimes: [
          {
            runtimeId: randomUUID(),
            runtimeGeneration: 1,
            lifetimeId: randomUUID(),
            buildId,
            configSha256: "a".repeat(64),
          },
        ],
        tasks: [],
        projects: [
          {
            projectId: randomUUID(),
            preparationIntentId: randomUUID(),
            nativeThreadId: randomUUID(),
            leaseId: randomUUID(),
            leaseGeneration: 1,
            checkoutDigest: "b".repeat(64),
          },
        ],
        barrierIds: [],
        treeReceiptDigests: [],
        idleRuntimeId: null,
        resumeRequestId: null,
        resumeIntentRuntimeId: null,
        resumeIntentEventId: null,
        holdReason: null,
      },
    },
  ]);
  expect((await codexAccountRoute(request(), workspaceId)).status).toBe(200);
  expect(mock.execute.mock.calls.at(-1)?.[2]).toEqual({
    operation: "codex-account",
    account: { action: "status", cached: true },
  });
  expect(
    (
      await codexAccountRoute(
        request({ action: "disconnect", lifetimeId, generation: 0 }),
        workspaceId,
      )
    ).status,
  ).toBe(409);
  expect(mock.execute).toHaveBeenCalledTimes(1);
  expect(
    (await codexAccountRoute(request({ action: "cancel", lifetimeId, generation: 0 }), workspaceId))
      .status,
  ).toBe(200);
  expect(mock.execute.mock.calls.at(-1)?.[2]).toEqual({
    operation: "codex-account",
    account: { action: "cancel", lifetimeId, generation: 0 },
  });
  expect(
    (await codexAccountRoute(request({ action: "status", cached: true }), workspaceId)).status,
  ).toBe(409);
});
