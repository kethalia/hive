import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindUnique = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const mockCookieStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => mockCookieStore),
}));

vi.mock("@hive/db", () => ({
  getDb: () => ({
    user: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  getRequestSession: (...args: unknown[]) => mockGetSession(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import {
  getTerminalSettingsAction,
  updateTerminalSettingsAction,
} from "@/lib/actions/user-settings";

const validSession = {
  user: {
    id: "user-123",
    coderUrl: "https://coder.example.com",
    coderUserId: "cu1",
    username: "testuser",
    email: "test@example.com",
  },
  session: {
    id: "sid1",
    sessionId: "sess-123",
    expiresAt: new Date(Date.now() + 86_400_000),
  },
};

const sensitiveFailureText =
  "terminal output leaked /home/coder/projects/kethalia/hive clipboard=secret cloneProof=hidden";

describe("user terminal settings actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetSession.mockResolvedValue(validSession);
    mockFindUnique.mockResolvedValue({ terminalControlsBeyondMobile: true });
    mockUpdate.mockResolvedValue({ terminalControlsBeyondMobile: false });
  });

  it("reads authenticated terminal settings scoped to the current user", async () => {
    const result = await getTerminalSettingsAction();

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({ terminalControlsBeyondMobile: true });
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: "user-123" },
      select: { terminalControlsBeyondMobile: true },
    });
  });

  it("defaults reads to false when the authenticated user row is unexpectedly absent", async () => {
    mockFindUnique.mockResolvedValueOnce(null);

    const result = await getTerminalSettingsAction();

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({ terminalControlsBeyondMobile: false });
  });

  it("normalizes malformed read rows to the default DTO without leaking internals", async () => {
    mockFindUnique.mockResolvedValueOnce({ terminalControlsBeyondMobile: sensitiveFailureText });

    const result = await getTerminalSettingsAction();

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({ terminalControlsBeyondMobile: false });
    expect(JSON.stringify(result)).not.toContain("/home/coder");
    expect(JSON.stringify(result)).not.toContain("clipboard");
    expect(JSON.stringify(result)).not.toContain("terminal output");
  });

  it("updates only the authenticated user's terminal setting and returns the saved boolean", async () => {
    mockUpdate.mockResolvedValueOnce({ terminalControlsBeyondMobile: true });

    const result = await updateTerminalSettingsAction({ terminalControlsBeyondMobile: true });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({ terminalControlsBeyondMobile: true });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "user-123" },
      data: { terminalControlsBeyondMobile: true },
      select: { terminalControlsBeyondMobile: true },
    });
  });

  it("does not cross user boundaries when another authenticated user updates the setting", async () => {
    mockGetSession.mockResolvedValueOnce({
      ...validSession,
      user: { ...validSession.user, id: "user-456" },
    });

    await updateTerminalSettingsAction({ terminalControlsBeyondMobile: false });

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-456" },
        data: { terminalControlsBeyondMobile: false },
      }),
    );
  });

  it("rejects unauthenticated reads before touching the database", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await getTerminalSettingsAction();

    expect(result?.serverError).toBe("Not authenticated");
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects wrong-type input before database writes", async () => {
    const result = await updateTerminalSettingsAction({
      terminalControlsBeyondMobile: "true",
    } as never);

    expect(result?.validationErrors).toBeDefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects extra input fields before database writes", async () => {
    const result = await updateTerminalSettingsAction({
      terminalControlsBeyondMobile: true,
      workspaceId: "workspace-1",
    } as never);

    expect(result?.validationErrors).toBeDefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("surfaces database read errors as sanitized safe-action failures", async () => {
    mockFindUnique.mockRejectedValueOnce(new Error(sensitiveFailureText));

    const result = await getTerminalSettingsAction();

    expect(result?.serverError).toBe("Terminal settings are unavailable. Refresh and try again.");
    expect(JSON.stringify(result)).not.toContain("/home/coder");
    expect(JSON.stringify(result)).not.toContain("clipboard");
    expect(JSON.stringify(result)).not.toContain("terminal output");
  });

  it("surfaces database update errors as sanitized safe-action failures", async () => {
    mockUpdate.mockRejectedValueOnce(new Error(sensitiveFailureText));

    const result = await updateTerminalSettingsAction({ terminalControlsBeyondMobile: true });

    expect(result?.serverError).toBe("Terminal settings are unavailable. Refresh and try again.");
    expect(JSON.stringify(result)).not.toContain("/home/coder");
    expect(JSON.stringify(result)).not.toContain("clipboard");
    expect(JSON.stringify(result)).not.toContain("terminal output");
  });

  it("treats malformed update rows as sanitized safe-action failures", async () => {
    mockUpdate.mockResolvedValueOnce({ terminalControlsBeyondMobile: sensitiveFailureText });

    const result = await updateTerminalSettingsAction({ terminalControlsBeyondMobile: true });

    expect(result?.serverError).toBe("Terminal settings are unavailable. Refresh and try again.");
    expect(JSON.stringify(result)).not.toContain("/home/coder");
    expect(JSON.stringify(result)).not.toContain("clipboard");
    expect(JSON.stringify(result)).not.toContain("terminal output");
  });
});
