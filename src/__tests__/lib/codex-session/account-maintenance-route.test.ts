import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ owner: vi.fn(), accountMaintenance: vi.fn() }));
vi.mock("@/lib/codex-session/guardian-factory.server", () => ({
  createGuardianService: () => ({ accountMaintenance: mock.accountMaintenance }),
}));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mock.owner }));
vi.mock("@/lib/codex-session/registered-session.server", () => ({
  registeredSessionConfig: () => ({ hiveOrigin: "https://hive.invalid" }),
}));

import { POST } from "@/app/api/workspaces/[workspaceId]/account-maintenance/route";

const workspaceId = randomUUID();
const request = (body: unknown = { action: "status" }, origin = "https://hive.invalid") =>
  new Request(`https://hive.invalid/api/workspaces/${workspaceId}/account-maintenance`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const context = { params: Promise.resolve({ workspaceId }) };
beforeEach(() => {
  for (const name of [
    "HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED",
    "HIVE_GUARDIAN_ENABLED",
    "HIVE_CODEX_GATEWAY_ENABLED",
  ])
    vi.stubEnv(name, "true");
  mock.owner.mockResolvedValue({ user: { id: "hive-owner", coderUserId: "coder-owner" } });
  mock.accountMaintenance.mockResolvedValue({
    schemaVersion: 1,
    version: 0,
    maintenanceId: null,
    state: "available",
    holdReason: null,
    runtimeId: null,
    runtimeGeneration: null,
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
it("requires the explicit owner feature, ordinary session and exact browser origin", async () => {
  vi.stubEnv("HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED", "false");
  expect((await POST(request(), context)).status).toBe(404);
  vi.stubEnv("HIVE_CODEX_ACCOUNT_MAINTENANCE_ENABLED", "true");
  expect((await POST(request({}, "https://other.invalid"), context)).status).toBe(403);
  mock.owner.mockResolvedValueOnce(null);
  expect((await POST(request(), context)).status).toBe(401);
  expect(mock.accountMaintenance).not.toHaveBeenCalled();
});
it("never accepts an unconfirmed intent, model operation, credential or arbitrary path", async () => {
  for (const value of [
    { action: "request", confirmed: false },
    { action: "maintenance_resume_intent" },
    { action: "status", token: "PRIVATE" },
  ])
    expect((await POST(request(value), context)).status).toBe(400);
  expect((await POST(new Request(`${request().url}?other=1`, request()), context)).status).toBe(
    400,
  );
  expect(mock.accountMaintenance).not.toHaveBeenCalled();
});
it("passes the authenticated owner only and strictly projects public status", async () => {
  const response = await POST(request(), context);
  expect(response.status).toBe(200);
  expect(mock.accountMaintenance).toHaveBeenCalledWith(
    { hiveUserId: "hive-owner", coderUserId: "coder-owner" },
    workspaceId,
    { action: "status" },
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  mock.accountMaintenance.mockResolvedValueOnce({
    schemaVersion: 1,
    version: 0,
    maintenanceId: null,
    state: "available",
    holdReason: null,
    runtimeId: null,
    runtimeGeneration: null,
    parkedJournalDigest: "PRIVATE_HASH",
  });
  const rejected = await POST(request(), context);
  expect(rejected.status).toBe(409);
  expect(await rejected.text()).not.toContain("PRIVATE_HASH");
});
