import { afterEach, describe, expect, it, vi } from "vitest";
import { guardianPost } from "@/lib/codex-session/guardian-route.server";
import { guardianTransportEnvelopeSchema } from "@/lib/codex-session/guardian-transport-contracts";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";

const request = (suffix = "", headers: HeadersInit = {}, body = "{}") =>
  new Request(`https://hive.invalid/api/codex-host/guardians${suffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
afterEach(() => vi.unstubAllEnvs());
describe("fixed signed guardian route", () => {
  it("is default off before body/authority access", async () => {
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "false");
    const factory = vi.fn();
    expect((await guardianPost(request(), factory)).status).toBe(404);
    expect(factory).not.toHaveBeenCalled();
  });
  it("rejects browser origins, query/encoded path variants and unsupported methods before authority", async () => {
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
    const factory = vi.fn();
    for (const input of [
      request("", { Origin: "https://hive.invalid" }),
      request("?"),
      request("?capability=forbidden"),
      request("/"),
      new Request("https://hive.invalid/api/codex-host/%67uardians", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    ])
      expect((await guardianPost(input, factory)).status).toBeGreaterThanOrEqual(400);
    expect(
      (await guardianPost(new Request("https://hive.invalid/api/codex-host/guardians"), factory))
        .status,
    ).toBe(405);
    expect(factory).not.toHaveBeenCalled();
  });
  it("ambient cookies and forwarded owner headers cannot establish host authority", async () => {
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
    const execute = vi.fn(async () => {
      throw new RegistrationRejected();
    });
    const response = await guardianPost(
      request("", {
        Cookie: "session=fake",
        "X-Forwarded-User": "owner",
        Authorization: "Bearer fake",
      }),
      () => ({ execute }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "host_authentication_required" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects malformed/oversized body and unknown command fields without leaking input", async () => {
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
    const execute = vi.fn(async (body: unknown) => {
      guardianTransportEnvelopeSchema.parse(body);
      return {
        accepted: true,
        runtimeId: "11111111-1111-4111-8111-111111111111",
        runtimeGeneration: 1,
      };
    });
    expect(
      (await guardianPost(request("", {}, '{"credential":"must-not-echo"}'), () => ({ execute })))
        .status,
    ).toBe(400);
    const factory = vi.fn();
    expect((await guardianPost(request("", {}, "x".repeat(100000)), factory)).status).toBe(400);
    expect(factory).not.toHaveBeenCalled();
  });
  it("aborted caller cannot receive a late positive receipt", async () => {
    vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
    const abort = new AbortController();
    let entered: () => void = () => {},
      release: () => void = () => {};
    const started = new Promise<void>((done) => {
        entered = done;
      }),
      gate = new Promise<void>((done) => {
        release = done;
      });
    const req = new Request("https://hive.invalid/api/codex-host/guardians", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: abort.signal,
    });
    const pending = guardianPost(req, () => ({
      execute: async () => {
        entered();
        await gate;
        return {
          accepted: true,
          runtimeId: "11111111-1111-4111-8111-111111111111",
          runtimeGeneration: 1,
        };
      },
    }));
    await started;
    abort.abort();
    release();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "guardian_unavailable" });
  });
});
