import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  deliverGuardianEnrollment,
  deliverRegistrationGrant,
  exchangeVerifiedWorkspaceAppSessionCookie,
  exchangeVerifiedWorkspaceAppTerminalCookie,
  exchangeVerifiedWorkspaceVoiceCookie,
  postToVerifiedWorkspaceApp,
  requestGuardianIdentity,
} from "@/lib/codex-session/bootstrap-delivery.server";

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
  it("guardian calls use only their fixed app paths with a fresh scoped cookie", async () => {
    for (const fixedPath of ["/guardian/identity", "/guardian/bootstrap"]) {
      const f = fixture();
      f.coder.getApplicationAuthRedirect.mockResolvedValue(
        `${origin + fixedPath}?coder_application_connect_api_key_35e783=encrypted`,
      );
      f.fetcher
        .mockReset()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 303,
            headers: {
              Location: fixedPath,
              "Set-Cookie": `${name}=scoped_secret; Path=/; HttpOnly; Secure`,
            },
          }),
        )
        .mockResolvedValueOnce(Response.json({ fixture: true }));
      const nonce = "a".repeat(64),
        grant = "b".repeat(100);
      const result =
        fixedPath === "/guardian/identity"
          ? await requestGuardianIdentity(f.coder, f.issued.binding, nonce, f.fetcher)
          : await deliverGuardianEnrollment(f.coder, f.issued.binding, grant, f.fetcher);
      expect(result).toEqual({ fixture: true });
      expect(f.coder.getApplicationAuthRedirect).toHaveBeenCalledWith(origin + fixedPath);
      expect(f.fetcher.mock.calls[1]).toMatchObject([
        origin + fixedPath,
        {
          method: "POST",
          redirect: "manual",
          credentials: "omit",
          headers: { "Content-Type": "application/json", Cookie: `${name}=scoped_secret` },
          body: JSON.stringify(fixedPath === "/guardian/identity" ? { nonce } : { grant }),
        },
      ]);
    }
  });
  it("guardian identity cannot choose a nonce query or follow an exchange to another path", async () => {
    const f = fixture();
    await expect(
      requestGuardianIdentity(f.coder, f.issued.binding, "a?token=x", f.fetcher),
    ).rejects.toThrow();
    expect(f.coder.getApplicationAuthRedirect).not.toHaveBeenCalled();
    await expect(
      requestGuardianIdentity(f.coder, f.issued.binding, "a".repeat(64), f.fetcher),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
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

it("exchanges only the fixed read-session path without forwarding owner credentials", async () => {
  const f = fixture();
  f.coder.getApplicationAuthRedirect.mockResolvedValue(
    `${origin}/session?coder_application_connect_api_key_35e783=encrypted`,
  );
  f.fetcher.mockReset().mockResolvedValue(
    new Response(null, {
      status: 303,
      headers: {
        Location: "/session",
        "Set-Cookie": `${name}=scoped_secret; Path=/; HttpOnly; Secure`,
      },
    }),
  );
  await expect(
    exchangeVerifiedWorkspaceAppSessionCookie(
      f.coder,
      f.issued.binding,
      f.issued.expiresAt,
      f.fetcher,
    ),
  ).resolves.toEqual({ cookie: `${name}=scoped_secret`, url: `${origin}/session` });
  expect(f.coder.getApplicationAuthRedirect).toHaveBeenCalledWith(`${origin}/session`);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.fetcher.mock.calls[0][1]).toMatchObject({
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
});
it("bounds task-start bytes before cookie exchange, including multibyte input", async () => {
  const f = fixture();
  await expect(
    postToVerifiedWorkspaceApp(
      f.coder,
      f.issued.binding,
      { path: "/projects/tasks/start", body: "界".repeat(32769), expiresAt: f.issued.expiresAt },
      f.fetcher,
    ),
  ).rejects.toThrow();
  expect(f.coder.getApplicationAuthRedirect).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("a cancelled task response stream rejects without waiting for an uncooperative cancel promise", async () => {
  const f = fixture(),
    controller = new AbortController();
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.fetcher
    .mockReset()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 303,
        headers: { Location: path, "Set-Cookie": `${name}=secret; Path=/; HttpOnly; Secure` },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull() {
            entered();
          },
          cancel() {
            return new Promise(() => {});
          },
        }),
      ),
    );
  const pending = postToVerifiedWorkspaceApp(
    f.coder,
    f.issued.binding,
    { path, body: "{}", expiresAt: f.issued.expiresAt, signal: controller.signal },
    f.fetcher,
  );
  void pending.catch(() => {});
  await reading;
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(f.fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
});

it("terminal cookie exchange is independently fixed to /terminal", async () => {
  const f = fixture();
  f.coder.getApplicationAuthRedirect.mockResolvedValue(
    `${origin}/terminal?coder_application_connect_api_key_35e783=encrypted`,
  );
  f.fetcher.mockReset().mockResolvedValue(
    new Response(null, {
      status: 303,
      headers: {
        Location: "/terminal",
        "Set-Cookie": `${name}=scoped_secret; Path=/; HttpOnly; Secure`,
      },
    }),
  );
  await expect(
    exchangeVerifiedWorkspaceAppTerminalCookie(
      f.coder,
      f.issued.binding,
      f.issued.expiresAt,
      f.fetcher,
    ),
  ).resolves.toEqual({ cookie: `${name}=scoped_secret`, url: `${origin}/terminal` });
  expect(f.coder.getApplicationAuthRedirect).toHaveBeenCalledWith(`${origin}/terminal`);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it("permits the bounded encoding expansion of a maximum-length escaped task prompt", async () => {
  const f = fixture();
  const path = "/projects/tasks/start";
  f.coder.getApplicationAuthRedirect.mockResolvedValue(
    `${origin}${path}?coder_application_connect_api_key_35e783=encrypted`,
  );
  f.fetcher
    .mockReset()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 303,
        headers: {
          Location: path,
          "Set-Cookie": `${name}=scoped_secret; Path=/; HttpOnly; Secure`,
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ accepted: true }));
  const payload = Buffer.from(JSON.stringify({ request: { text: "\t".repeat(32768) } })).toString(
    "base64url",
  );
  const body = JSON.stringify({ ticket: `header.${payload}.signature` });
  expect(Buffer.byteLength(body)).toBeGreaterThan(65536);
  await expect(
    postToVerifiedWorkspaceApp(
      f.coder,
      f.issued.binding,
      { path, body, expiresAt: f.issued.expiresAt },
      f.fetcher,
    ),
  ).resolves.toEqual({ accepted: true });
});

it("voice cookie exchanges are restricted to their fixed endpoints", async () => {
  for (const path of ["/voice", "/voice/identity"] as const) {
    const f = fixture();
    f.coder.getApplicationAuthRedirect.mockResolvedValue(
      `${origin}${path}?coder_application_connect_api_key_35e783=encrypted`,
    );
    f.fetcher.mockReset().mockResolvedValue(
      new Response(null, {
        status: 303,
        headers: {
          Location: path,
          "Set-Cookie": `${name}=scoped_secret; Path=/; HttpOnly; Secure`,
        },
      }),
    );
    await expect(
      exchangeVerifiedWorkspaceVoiceCookie(
        f.coder,
        f.issued.binding,
        path,
        f.issued.expiresAt,
        f.fetcher,
      ),
    ).resolves.toEqual({ cookie: `${name}=scoped_secret`, url: `${origin}${path}` });
    expect(f.coder.getApplicationAuthRedirect).toHaveBeenCalledWith(`${origin}${path}`);
  }
  const f = fixture();
  await expect(
    exchangeVerifiedWorkspaceVoiceCookie(
      f.coder,
      f.issued.binding,
      "/terminal" as "/voice",
      f.issued.expiresAt,
      f.fetcher,
    ),
  ).rejects.toThrow();
  expect(f.coder.getApplicationAuthRedirect).not.toHaveBeenCalled();
});
