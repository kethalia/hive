import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestSession: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.getRequestSession }));

import { CoderOAuthLogin } from "@/app/login/coder-oauth-login";
import { LoginForm } from "@/app/login/login-form";
import LoginPage from "@/app/login/page";

describe("LoginPage session routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("redirects authenticated visitors to the workspace home", async () => {
    mocks.getRequestSession.mockResolvedValue({ user: { id: "user-1" } });

    await LoginPage({});

    expect(mocks.redirect).toHaveBeenCalledWith("/workspaces");
  });

  it("renders the login form when no session exists", async () => {
    mocks.getRequestSession.mockResolvedValue(null);

    const page = await LoginPage({});

    expect(page.props.children[1].type).toBe(LoginForm);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("shows the Coder action in the sign-in panel when OAuth is enabled", async () => {
    vi.stubEnv("HIVE_CODER_OAUTH_ENABLED", "true");
    mocks.getRequestSession.mockResolvedValue(null);

    const page = await LoginPage({ searchParams: Promise.resolve({ error: "sign_in_failed" }) });

    const [header, signIn] = page.props.children;
    expect(header.props.children[1].props.children).toBe("Sign in to Hive");
    expect(signIn.type).toBe(CoderOAuthLogin);
    expect(signIn.props.error).toBe(true);
  });
});
