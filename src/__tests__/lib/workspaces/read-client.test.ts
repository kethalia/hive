import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestVerifiedWorkspaceRead } from "@/lib/codex-session/bootstrap-delivery.server";
import { WorkspaceReadClient } from "@/lib/workspaces/read-client.server";
import { readFixture } from "./read-fixture";

const fixtures: ReturnType<typeof readFixture>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of fixtures.splice(0)) await f.close();
});
const fixture = () => {
  const f = readFixture();
  fixtures.push(f);
  return f;
};
describe("signed workspace read client", () => {
  it("verifies actual service identity and lifetime, returning typed read-only missing-server facts", async () => {
    const f = fixture(),
      transport = vi.fn<typeof requestVerifiedWorkspaceRead>(async (_c, _b, r) =>
        f.host.dispatch({ ticket: r.ticket }),
      ),
      client = new WorkspaceReadClient(f.config, f.coder, f.binding, transport);
    expect(await client.read({ operation: "sessions" })).toEqual({
      sessions: [],
      nextCursor: null,
    });
    expect(transport).toHaveBeenCalledTimes(2);
    const claims = transport.mock.calls.map(([, , r]) =>
      JSON.parse(Buffer.from(r.ticket.split(".")[1], "base64url").toString()),
    );
    expect(claims[0].lifetimeId).toBeNull();
    expect(claims[1].lifetimeId).toBe(f.host.lifetimeId);
    expect(claims.every((c) => c.binding.ownerId === f.binding.ownerId)).toBe(true);
    expect(claims.every((c) => !Object.hasOwn(c.request, "command"))).toBe(true);
  });
  it("crosses actual fixed app-cookie exchange and local HTTP service without forwarding an owner token", async () => {
    const f = fixture(),
      address = await f.host.listen(),
      cookieName = `coder_subdomain_app_session_token_${createHash("sha256").update("*.apps.invalid").digest("hex").slice(0, 32)}`;
    const fetchApp = vi.fn<typeof fetch>(async (target, init) => {
      const url = new URL(String(target));
      expect(url.origin).toBe(f.binding.appOrigin);
      expect(url.pathname).toBe("/workspace/read");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      if (init?.method === "GET")
        return new Response(null, {
          status: 303,
          headers: {
            Location: `${f.binding.appOrigin}/workspace/read`,
            "Set-Cookie": `${cookieName}=fixture-cookie; HttpOnly; Secure; Path=/`,
          },
        });
      expect(new Headers(init?.headers).get("cookie")).toBe(`${cookieName}=fixture-cookie`);
      expect(url.search).toBe("");
      return new Promise((done, reject) => {
        const body = String(init?.body),
          req = httpRequest(
            {
              host: "127.0.0.1",
              port: typeof address === "object" && address ? address.port : 0,
              path: "/workspace/read",
              method: "POST",
              headers: {
                Host: url.host,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (b) => chunks.push(b));
              res.on("end", () =>
                done(new Response(Buffer.concat(chunks), { status: res.statusCode })),
              );
            },
          );
        req.on("error", reject);
        req.end(body);
      });
    });
    const transport: typeof requestVerifiedWorkspaceRead = (c, b, r) =>
        requestVerifiedWorkspaceRead(c, b, r, fetchApp),
      client = new WorkspaceReadClient(f.config, f.coder, f.binding, transport);
    expect(await client.read({ operation: "directory", sessionName: "main" })).toEqual({
      cwd: null,
      state: "missing_server",
    });
    expect(fetchApp).toHaveBeenCalledTimes(4);
  });
  it("rejects wrong pinned manifest/config, substituted signed identity or a different process lifetime", async () => {
    const f = fixture();
    for (const mutation of ["manifest", "profile", "lifetime", "proof"]) {
      let count = 0;
      const transport: typeof requestVerifiedWorkspaceRead = async (_c, _b, r) => {
        const reply = await f.host.dispatch({ ticket: r.ticket });
        count++;
        if (mutation === "profile" && count === 1) reply.result.data.profile = "game";
        if (mutation === "lifetime" && count === 2) reply.lifetimeId = randomUUID();
        if (mutation === "proof") reply.proof = "A".repeat(86);
        return reply;
      };
      const client = new WorkspaceReadClient(
        { ...f.config, ...(mutation === "manifest" ? { manifestSha256: "0".repeat(64) } : {}) },
        f.coder,
        f.binding,
        transport,
      );
      await expect(client.read({ operation: "sessions" })).rejects.toThrow();
      expect(count).toBe(mutation === "lifetime" ? 2 : 1);
    }
  });
  it("cancellation and late identity ACK cannot dispatch a subsequent read", async () => {
    for (const late of [false, true]) {
      const f = fixture(),
        abort = new AbortController();
      let calls = 0;
      if (late) vi.useFakeTimers();
      const client = new WorkspaceReadClient(f.config, f.coder, f.binding, async (_c, _b, r) => {
        calls++;
        const reply = await f.host.dispatch({ ticket: r.ticket });
        if (late) vi.setSystemTime(Date.now() + 16000);
        else abort.abort();
        return reply;
      });
      await expect(client.read({ operation: "sessions" }, abort.signal)).rejects.toThrow();
      expect(calls).toBe(1);
      vi.useRealTimers();
    }
  });
  it("returns explicit per-path unsupported-root and unavailable-CWD statuses", async () => {
    const f = fixture(),
      client = new WorkspaceReadClient(f.config, f.coder, f.binding, async (_c, _b, r) =>
        f.host.dispatch({ ticket: r.ticket }),
      );
    expect(
      (
        await client.read({
          operation: "paths",
          sessionName: "main",
          paths: ["relative.txt", "/etc/passwd"],
        })
      ).candidates,
    ).toEqual([
      { index: 0, status: "cwd_unavailable" },
      { index: 1, status: "outside_supported_root" },
    ]);
  });
});
