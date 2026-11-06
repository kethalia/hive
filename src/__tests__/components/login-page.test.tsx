import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), redirect: vi.fn(), mode: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: mocks.session }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/coder-login.server", async (original) => ({
  ...(await original<typeof import("@/lib/auth/coder-login.server")>()),
  coderLoginMode: mocks.mode,
}));

import LoginPage, { dynamic } from "@/app/login/page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());
describe("login page method selection", () => {
  it("renders only Continue with Coder and fixed local navigation when OAuth is configured", async () => {
    expect(dynamic).toBe("force-dynamic");
    mocks.mode.mockReturnValue("oauth");
    const html = renderToStaticMarkup(await LoginPage({}));
    expect(html).toContain("Continue with Coder");
    expect(html).toContain("/api/auth/coder/start");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="email"');
  });
  it("keeps the legacy credentials form when OAuth is disabled", async () => {
    mocks.mode.mockReturnValue("legacy");
    const html = renderToStaticMarkup(await LoginPage({}));
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain("Continue with Coder");
  });
  it("enabled unavailable config offers no password fallback or active action", async () => {
    mocks.mode.mockReturnValue("oauth-unavailable");
    const html = renderToStaticMarkup(await LoginPage({}));
    expect(html).toContain("temporarily unavailable");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('action="/api/auth/coder/start"');
  });
  it("never renders callback code/state or arbitrary errors", async () => {
    mocks.mode.mockReturnValue("oauth");
    const html = renderToStaticMarkup(
      await LoginPage({
        searchParams: Promise.resolve({
          error: "<script>private</script>",
          code: "private-code",
          state: "private-state",
        }),
      }),
    );
    expect(html).not.toContain("private-code");
    expect(html).not.toContain("private-state");
    expect(html).not.toContain("script&gt;");
  });
});
