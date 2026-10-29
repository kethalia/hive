import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), discover: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/projects/workspace", async (importOriginal) => ({
  ...(await importOriginal()),
  discoverWorkspaceProjects: mocks.discover,
}));

import { GET } from "@/app/api/projects/route";
import { ProjectDiscoveryError } from "@/lib/projects/workspace";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const user = { id: "owner", coderUserId: "coder-owner" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "true");
  mocks.session.mockResolvedValue({ user });
});
afterEach(() => vi.unstubAllEnvs());

describe("owner-authenticated project API", () => {
  it("defaults disabled and does not fetch sessions or credentials", async () => {
    vi.stubEnv("HIVE_PROJECT_DISCOVERY_ENABLED", "");
    const response = await GET(
      new Request(`https://hive.example.com/api/projects?workspaceId=${workspaceId}`),
    );
    expect(response.status).toBe(404);
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("requires a valid Hive session", async () => {
    mocks.session.mockResolvedValue(null);
    expect(
      (await GET(new Request(`https://hive.example.com/api/projects?workspaceId=${workspaceId}`)))
        .status,
    ).toBe(401);
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it.each([
    "workspaceId=bad",
    `workspaceId=${workspaceId}&url=https://attacker.invalid`,
    `workspaceId=${workspaceId}&page=1&page=2`,
    `workspaceId=${workspaceId}&page=0`,
    `workspaceId=${workspaceId}&perPage=101`,
  ])("rejects invalid or ambiguous inputs %s", async (query) => {
    expect((await GET(new Request(`https://hive.example.com/api/projects?${query}`))).status).toBe(
      400,
    );
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it("binds workspace discovery to the authenticated owner and disables response caching", async () => {
    mocks.discover.mockResolvedValue({ repositories: [] });
    const response = await GET(
      new Request(
        `https://hive.example.com/api/projects?workspaceId=${workspaceId}&page=2&perPage=50`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.discover).toHaveBeenCalledWith(user, { workspaceId, page: 2, perPage: 50 });
  });
  it("returns a stable revocation code and no remote details", async () => {
    mocks.discover.mockRejectedValue(new ProjectDiscoveryError("github_auth_required"));
    const response = await GET(
      new Request(`https://hive.example.com/api/projects?workspaceId=${workspaceId}`),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("github_auth_required");
  });
  it("rejects cross-site discovery", async () => {
    const response = await GET(
      new Request(`https://hive.example.com/api/projects?workspaceId=${workspaceId}`, {
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.discover).not.toHaveBeenCalled();
  });
});
