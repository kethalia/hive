import { beforeEach, describe, expect, it, vi } from "vitest";

const { session } = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: session }));

import { GET } from "@/app/api/app-version/route";
import { APP_VERSION } from "@/lib/app-version";

beforeEach(() => vi.resetAllMocks());

describe("GET /api/app-version", () => {
  it("requires authentication and prevents caching", async () => {
    session.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("returns the deployed build identity without caching", async () => {
    session.mockResolvedValue({ user: { id: "user" } });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(APP_VERSION);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
