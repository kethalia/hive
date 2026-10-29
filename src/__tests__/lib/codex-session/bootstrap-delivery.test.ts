import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deliverRegistrationGrant } from "@/lib/codex-session/bootstrap-delivery.server";

const origin = "https://app--main--workspace--owner.apps.example.com",
  path = "/registration/bootstrap";
const name =
  "coder_subdomain_app_session_token_" +
  createHash("sha256").update("*.apps.example.com").digest("hex").slice(0, 32);
function fixture() {
  const coder = {
    getBaseUrl: () => "https://coder.example.com",
    getApplicationsHost: async () => "*.apps.example.com",
    getApplicationAuthRedirect: vi.fn(
      async () => `${origin + path}?coder_application_connect_api_key_35e783=encrypted`,
    ),
  };
  const issued = {
    grant: "signed-private-grant",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    binding: {
      coderOrigin: coder.getBaseUrl(),
      hiveUserId: "user",
      ownerId: "owner",
      workspaceId: "workspace",
      buildId: "build",
      agentId: "agent",
      templateId: "template",
      appOrigin: origin,
      appId: "app",
      projects: [],
    },
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 303,
        headers: {
          Location: path,
          "Set-Cookie": `${name}=scoped_secret; Domain=apps.example.com; Path=/; HttpOnly; Secure`,
        },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ registrationId: "registered", expiresAt: issued.expiresAt }),
    );
  return { coder, issued, fetcher };
}
describe("private Coder app bootstrap delivery", () => {
  it("uses exact-origin app cookie and POST body, never an owner header or redirect following", async () => {
    const f = fixture();
    await expect(deliverRegistrationGrant(f.coder, f.issued, f.fetcher)).resolves.toEqual({
      registrationId: "registered",
      expiresAt: f.issued.expiresAt,
    });
    expect(f.coder.getApplicationAuthRedirect).toHaveBeenCalledWith(origin + path);
    const calls = f.fetcher.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]?.headers).toEqual({ Accept: "application/json" });
    expect(calls[1][1]).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: { Cookie: `${name}=scoped_secret` },
      body: JSON.stringify({ grant: f.issued.grant }),
    });
    expect(calls[1][0]).toBe(origin + path);
  });
  it("rejects cross-origin or extra-parameter auth redirect before fetching", async () => {
    const f = fixture();
    f.coder.getApplicationAuthRedirect.mockResolvedValue(
      `https://evil.example${path}?coder_application_connect_api_key_35e783=x`,
    );
    await expect(deliverRegistrationGrant(f.coder, f.issued, f.fetcher)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects cookie stripping redirects, malformed/duplicate cookies, and oversized headers", async () => {
    for (const headers of [
      { Location: "https://evil.example/" },
      { Location: path, "Set-Cookie": `${name}=secret; Path=/; HttpOnly` },
      {
        Location: path,
        "Set-Cookie": `${name}=secret; Path=/; HttpOnly; Secure`,
        "x-large": "a".repeat(33000),
      },
    ] as Array<Record<string, string>>) {
      const f = fixture();
      f.fetcher.mockReset().mockResolvedValue(new Response(null, { status: 303, headers }));
      await expect(deliverRegistrationGrant(f.coder, f.issued, f.fetcher)).rejects.toThrow();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("never follows a POST redirect or accepts oversized response", async () => {
    for (const response of [
      new Response(null, { status: 307, headers: { Location: "https://evil.example" } }),
      new Response("x".repeat(4097)),
    ]) {
      const f = fixture();
      f.fetcher
        .mockReset()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 303,
            headers: { Location: path, "Set-Cookie": `${name}=secret; Path=/; HttpOnly; Secure` },
          }),
        )
        .mockResolvedValueOnce(response);
      await expect(deliverRegistrationGrant(f.coder, f.issued, f.fetcher)).rejects.toThrow();
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    }
  });
});
