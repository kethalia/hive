import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestVerifiedWorkspaceAgent } from "@/lib/agents/workspace-app-transport.server";

const origin = "https://hive-agent--main--work--owner.apps.example";
const target = `${origin}/agent/operation`;
const cookieName = `coder_subdomain_app_session_token_${createHash("sha256").update("*.apps.example").digest("hex").slice(0, 32)}`;
const binding = {
  coderOrigin: "https://coder.example",
  ownerId: randomUUID(),
  workspaceId: randomUUID(),
  buildId: randomUUID(),
  templateId: randomUUID(),
  agentId: randomUUID(),
  appId: randomUUID(),
  appOrigin: origin,
};
function fixture() {
  const coder = {
    getBaseUrl: () => binding.coderOrigin,
    getApplicationsHost: vi.fn(async () => "*.apps.example"),
    getApplicationAuthRedirect: vi.fn(
      async () => `${target}?coder_application_connect_api_key_35e783=encrypted`,
    ),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 303,
        headers: {
          Location: "/agent/operation",
          "Set-Cookie": `${cookieName}=private_cookie; Path=/; Secure; HttpOnly`,
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ signed: "fixture" }));
  const controller = new AbortController();
  const request = {
    ticket: "private-ticket",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    signal: controller.signal,
  };
  return {
    coder,
    fetcher,
    controller,
    request,
    send: () => requestVerifiedWorkspaceAgent(coder, binding, request, fetcher),
  };
}
afterEach(() => vi.useRealTimers());
describe("fixed signed workspace-app HTTP transport", () => {
  it("sends only the scoped app cookie and signed body to the fixed path", async () => {
    const f = fixture();
    expect(await (await f.send()).json()).toEqual({ signed: "fixture" });
    expect(f.coder.getApplicationAuthRedirect).toHaveBeenCalledWith(target);
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    expect(f.fetcher.mock.calls[1]).toMatchObject([
      target,
      {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Cookie: `${cookieName}=private_cookie` },
        body: JSON.stringify({ ticket: "private-ticket" }),
      },
    ]);
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toMatch(/Authorization|Coder-Session-Token/);
  });

  it.each([
    "https://foreign.example/agent/operation?coder_application_connect_api_key_35e783=x",
    `${origin}/other?coder_application_connect_api_key_35e783=x`,
    `${target}?coder_application_connect_api_key_35e783=x&extra=y`,
    `${target}?coder_application_connect_api_key_35e783=x&coder_application_connect_api_key_35e783=y`,
    `${target}?coder_application_connect_api_key_35e783=x#fragment`,
  ])("rejects an unexpected Coder auth redirect before sending credentials %s", async (redirect) => {
    const f = fixture();
    f.coder.getApplicationAuthRedirect.mockResolvedValueOnce(redirect);
    await expect(f.send()).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    `${cookieName}=private_cookie; Path=/; Secure`,
    `${cookieName}=private_cookie; Path=/; HttpOnly`,
    `${cookieName}=private_cookie; Path=/other; Secure; HttpOnly`,
    `${cookieName}=invalid/value; Path=/; Secure; HttpOnly`,
    "unexpected_cookie=value; Path=/; Secure; HttpOnly",
  ])("rejects an invalid scoped cookie without posting a signed operation %s", async (cookie) => {
    const f = fixture();
    f.fetcher.mockReset().mockResolvedValueOnce(
      new Response(null, {
        status: 303,
        headers: { Location: "/agent/operation", "Set-Cookie": cookie },
      }),
    );
    await expect(f.send()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("rejects duplicate scoped cookies", async () => {
    const f = fixture();
    const headers = new Headers({ Location: "/agent/operation" });
    for (const value of ["one", "two"])
      headers.append("Set-Cookie", `${cookieName}=${value}; Path=/; Secure; HttpOnly`);
    f.fetcher.mockReset().mockResolvedValueOnce(new Response(null, { status: 303, headers }));
    await expect(f.send()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    "https://foreign.example/agent/operation",
    "/other",
    "/agent/operation?extra=1",
  ])("does not follow an altered exchange destination %s", async (location) => {
    const f = fixture();
    f.fetcher
      .mockReset()
      .mockResolvedValueOnce(new Response(null, { status: 303, headers: { Location: location } }));
    await expect(f.send()).rejects.toThrow();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("honors parent cancellation before and during cookie exchange", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.send()).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    const during = fixture();
    during.fetcher.mockReset().mockImplementationOnce(async (_input, init) => {
      during.controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/agent/operation",
          "Set-Cookie": `${cookieName}=private_cookie; Path=/; Secure; HttpOnly`,
        },
      });
    });
    await expect(during.send()).rejects.toThrow();
    expect(during.fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    2_000, 10_000,
  ])("keeps the earlier ticket or ten-second cookie deadline after Coder reads take %sms", async (elapsed) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
    const f = fixture();
    if (elapsed === 2_000) f.request.expiresAt = Math.floor(Date.now() / 1000) + 2;
    f.coder.getApplicationAuthRedirect.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + elapsed);
      return `${target}?coder_application_connect_api_key_35e783=encrypted`;
    });
    await expect(f.send()).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
