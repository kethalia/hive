import { afterEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/github/connection/route";

const mocks = vi.hoisted(() => ({ session: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/agents/portable-config.server", () => ({
  createProjectDiscoveryService: () => ({ execute: mocks.execute }),
}));
const origin = "https://hive.example";
const scope = {
  workspaceId: "96201ae7-9ec5-4c35-9372-94d197afef81",
  buildId: "1a6e2eea-7708-4ed9-8a62-6e0305ccff82",
};
function post(body: object, source = origin) {
  vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
  vi.stubEnv("HIVE_PUBLIC_ORIGIN", origin);
  return POST(
    new Request(`${origin}/api/github/connection`, {
      method: "POST",
      headers: { origin: source, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it("binds device sign-in to the authenticated owner, selected workspace and build", async () => {
  mocks.session.mockResolvedValue({ user: { id: "hive", coderUserId: "coder" } });
  mocks.execute.mockResolvedValue({
    revision: "initial",
    login: null,
    pending: null,
    outcome: null,
  });
  const response = await post({ ...scope, action: "start", revision: "initial" });
  expect(response.status).toBe(200);
  expect(mocks.execute).toHaveBeenCalledWith(
    { hiveUserId: "hive", coderUserId: "coder" },
    scope.workspaceId,
    {
      operation: "github-connection",
      connection: { action: "start", revision: "initial" },
    },
    expect.anything(),
    scope.buildId,
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
});
it("rejects unsigned origins, missing sessions, unscoped actions and supplied client identifiers", async () => {
  expect((await post({ ...scope, action: "status" }, "https://other.example")).status).toBe(403);
  expect((await post({ ...scope, action: "status" })).status).toBe(401);
  mocks.session.mockResolvedValue({ user: { id: "hive", coderUserId: "coder" } });
  expect((await post({ action: "status" })).status).toBe(400);
  expect(
    (await post({ ...scope, action: "start", revision: "initial", clientId: "injected" })).status,
  ).toBe(400);
  expect(mocks.execute).not.toHaveBeenCalled();
});
