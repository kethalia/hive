import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendClearSessionCookieHeaders,
  appendSetSessionCookieHeaders,
  getSessionCookieValuesFromHeader,
  sessionCookieDomainsToClear,
} from "@/lib/auth/session-cookie";

afterEach(() => vi.unstubAllEnvs());

describe("protected session cookie migration", () => {
  it.each([
    "hive.example.com",
    "pr-42.hive.example.com",
    "other.example.net",
  ])("never broadens the live cookie scope on %s", (hostname) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_DOMAIN", ".example.com");
    const headers = new Headers();
    appendSetSessionCookieHeaders(headers, "signed-session", hostname);
    const live = headers.getSetCookie().filter((value) => !value.includes("Max-Age=0;"));
    expect(live).toHaveLength(1);
    expect(live[0]).toContain("__Host-hive-session=signed-session; Path=/;");
    expect(live[0]).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(live[0]).not.toContain("Domain=");
    expect(
      headers
        .getSetCookie()
        .some((value) => value.includes("Domain=.example.com") && value.includes("Max-Age=0;")),
    ).toBe(true);
  });
  it("clears configured, auto-derived, and preview-parent legacy domains", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_DOMAIN", ".custom.example.com");
    expect(sessionCookieDomainsToClear("pr-42.hive.example.com")).toEqual([
      ".custom.example.com",
      ".pr-42.hive.example.com",
      ".hive.example.com",
    ]);
    const headers = new Headers();
    appendClearSessionCookieHeaders(headers, "pr-42.hive.example.com");
    expect(headers.getSetCookie()).toHaveLength(5);
    for (const value of headers.getSetCookie()) expect(value).toContain("Max-Age=0;");
    expect(headers.getSetCookie().at(-1)).toContain("__Host-hive-session=;");
    expect(headers.getSetCookie().at(-1)).not.toContain("Domain=");
  });
  it("ignores legacy production cookies and preserves all protected duplicates", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(getSessionCookieValuesFromHeader("hive-session=attacker")).toEqual([]);
    expect(
      getSessionCookieValuesFromHeader("hive-session=attacker; __Host-hive-session=victim"),
    ).toEqual(["victim"]);
    expect(
      getSessionCookieValuesFromHeader("__Host-hive-session=; __Host-hive-session=valid"),
    ).toEqual(["", "valid"]);
    expect(
      getSessionCookieValuesFromHeader("__Host-hive-session=same; __Host-hive-session=same"),
    ).toEqual(["same", "same"]);
  });
  it("keeps HTTP development host-only without Secure or prefix", () => {
    vi.stubEnv("NODE_ENV", "development");
    const headers = new Headers();
    appendSetSessionCookieHeaders(headers, "signed", "localhost");
    const live = headers.getSetCookie().at(-1);
    expect(live).toContain("hive-session=signed;");
    expect(live).not.toMatch(/Domain=|Secure|__Host-/);
  });
});
