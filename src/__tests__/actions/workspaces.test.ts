import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "fs/promises";

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
  getSession: vi.fn(),
}));

import { getCoderClientForUser } from "@/lib/coder/user-client";
import { getSession } from "@/lib/auth/session";
import { cookies } from "next/headers";

const mockedGetCoderClientForUser = vi.mocked(getCoderClientForUser);
const mockedGetSession = vi.mocked(getSession);
const mockedCookies = vi.mocked(cookies);

const MOCK_SESSION = {
  user: {
    id: "user-123",
    coderUrl: "https://coder.example.com",
    coderUserId: "coder-user-1",
    username: "testuser",
    email: "test@example.com",
  },
  session: {
    id: "sess-1",
    sessionId: "sess-id-1",
    expiresAt: new Date(Date.now() + 86400000),
  },
};

describe("workspace actions use authActionClient + getCoderClientForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("proxy route returns 401 for unauthenticated requests", async () => {
    mockedGetSession.mockResolvedValue(null);

    const { GET } = await import(
      "@/app/api/workspace-proxy/[workspaceId]/[[...path]]/route"
    );
    const url = "http://localhost/api/workspace-proxy/aaaaaaaa-1111-2222-3333-444444444444";
    const req = new Request(url);
    Object.defineProperty(req, "nextUrl", { value: new URL(url) });

    const response = await GET(req as never, {
      params: Promise.resolve({
        workspaceId: "aaaaaaaa-1111-2222-3333-444444444444",
      }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("proxy route does not use env var credentials", async () => {
    const source = await readFile(
      "src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts",
      "utf-8"
    );
    expect(source).toContain("getCoderClientForUser");
    expect(source).toContain("getSession");
    expect(source).not.toContain("process.env.CODER_URL");
    expect(source).not.toContain("process.env.CODER_SESSION_TOKEN");
  });

  it("proxy route metaCache key includes userId to prevent cross-user poisoning", async () => {
    const source = await readFile(
      "src/app/api/workspace-proxy/[workspaceId]/[[...path]]/route.ts",
      "utf-8"
    );
    expect(source).toMatch(/\$\{userId\}:\$\{workspaceId\}/);
  });
});
