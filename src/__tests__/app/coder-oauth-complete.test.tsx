import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", () => ({ getRequestSession: session }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Error("not-found");
  },
}));

import CompletePage from "@/app/login/complete/page";

const attempt = "f5ed9902-3689-49ee-ad83-050fdbe6abc9";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("OAuth popup completion session verification", () => {
  it("signals success only after resolving an authenticated Hive session", async () => {
    session.mockResolvedValue({ user: { id: "fixture-user" } });
    const page = await CompletePage({ searchParams: Promise.resolve({ attempt }) });
    expect(page.props).toEqual({ attempt, success: true });
    expect(session).toHaveBeenCalledOnce();
  });
  it("reports an absent session as a failed completion", async () => {
    session.mockResolvedValue(null);
    const page = await CompletePage({ searchParams: Promise.resolve({ attempt }) });
    expect(page.props).toEqual({ attempt, success: false });
  });
  it("preserves provider failure even when another session exists", async () => {
    session.mockResolvedValue({ user: { id: "fixture-user" } });
    const page = await CompletePage({ searchParams: Promise.resolve({ attempt, error: "1" }) });
    expect(page.props.success).toBe(false);
    expect(session).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "invalid",
    [attempt, attempt],
  ])("rejects an invalid attempt %s", async (value) => {
    const page = await CompletePage({ searchParams: Promise.resolve({ attempt: value }) });
    expect(page.props).toEqual({ attempt: null, success: false });
    expect(session).not.toHaveBeenCalled();
  });
  it("hides popup completion when OAuth is disabled", async () => {
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "false");
    await expect(CompletePage({ searchParams: Promise.resolve({ attempt }) })).rejects.toThrow(
      "not-found",
    );
    expect(session).not.toHaveBeenCalled();
  });
});
