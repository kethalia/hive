import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.getRequestSession }));

import { LoginForm } from "@/app/login/login-form";
import LoginPage from "@/app/login/page";

describe("LoginPage session routing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redirects authenticated visitors to the workspace home", async () => {
    mocks.getRequestSession.mockResolvedValue({ user: { id: "user-1" } });

    await LoginPage();

    expect(mocks.redirect).toHaveBeenCalledWith("/workspaces");
  });

  it("renders the login form when no session exists", async () => {
    mocks.getRequestSession.mockResolvedValue(null);

    const page = await LoginPage();

    expect(page.type).toBe(LoginForm);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
