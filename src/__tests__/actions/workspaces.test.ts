import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { cookies } from "next/headers";
import { getRequestSession, getSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";

const _mockedGetCoderClientForUser = vi.mocked(getCoderClientForUser);
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
    vi.clearAllMocks();
    mockedGetRequestSession.mockResolvedValue(MOCK_SESSION);
    mockedGetSession.mockResolvedValue(MOCK_SESSION);
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

  it("retired proxy returns inert content even without a session", async () => {
    mockedGetSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route");
    const response = GET();
    expect(response.status).toBe(410);
    expect((await response.json()).error).toContain("Workspace proxy retired");
    expect(_mockedGetCoderClientForUser).not.toHaveBeenCalled();
  });
});
