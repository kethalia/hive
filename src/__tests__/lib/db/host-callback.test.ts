import { describe, expect, it } from "vitest";
import { isHostCallbackTransport } from "../../../../deploy/cloudflare/app/host-callback";

const base = "https://preview.example",
  registration = "/api/codex-host/registrations",
  heartbeat = `${registration}/00000000-0000-4000-8000-000000000001/heartbeat`;
function request(path = registration, init: RequestInit = {}) {
  return new Request(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
describe("native callback transport exception (signature checks still required)", () => {
  it("is disabled by default and accepts only native registration/UUID heartbeat POST transports", () => {
    for (const value of [undefined, "false", true, "TRUE"])
      expect(isHostCallbackTransport(request(), value)).toBe(false);
    expect(isHostCallbackTransport(request(), "true")).toBe(true);
    expect(isHostCallbackTransport(request(heartbeat), "true")).toBe(true);
  });
  it.each([
    "/api/projects",
    `${registration}/`,
    `${registration}/extra`,
    `${registration}?invalid=1`,
    `${heartbeat}?invalid=1`,
    `${registration}/not-uuid/heartbeat`,
    "/api/codex-host/%72egistrations",
    "/api/codex-host%2fregistrations",
    `${registration}/00000000-0000-4000-8000-000000000001%2fheartbeat`,
  ])("rejects any other route or encoded variant %s", (path) => {
    expect(isHostCallbackTransport(request(path), "true")).toBe(false);
  });
  it("rejects browser/action/upgrade transports, unsupported encoding and oversize declared bodies", () => {
    const variants: Record<string, string>[] = [
      { "Content-Type": "text/plain" },
      { "Content-Type": "application/json", Origin: base },
      { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      { "Content-Type": "application/json", "Next-Action": "action" },
      { "Content-Type": "application/json", Upgrade: "websocket" },
      { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      { "Content-Type": "application/json", "Content-Length": "65537" },
      { "Content-Type": "application/json", "Content-Length": "-1" },
    ];
    for (const headers of variants)
      expect(isHostCallbackTransport(request(registration, { headers }), "true")).toBe(false);
    expect(
      isHostCallbackTransport(
        request(heartbeat, {
          headers: { "Content-Type": "application/json", "Content-Length": "4097" },
        }),
        "true",
      ),
    ).toBe(false);
    expect(isHostCallbackTransport(request(registration, { method: "GET" }), "true")).toBe(false);
  });
});
