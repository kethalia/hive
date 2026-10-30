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
    `${registration}?`,
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
  const capabilities = {
    HIVE_GUARDIAN_ENABLED: "true",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
    HIVE_DELIVERY_NATIVE_ENABLED: "true",
    HIVE_DELIVERY_GITHUB_SOURCE_ENABLED: "true",
    HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED: "true",
  };
  it.each([
    ["/api/codex-host/guardians", "HIVE_GUARDIAN_ENABLED", 65536],
    ["/api/delivery/host", "HIVE_DELIVERY_MANAGER_ENABLED", 65536],
    ["/api/delivery/native", "HIVE_DELIVERY_NATIVE_ENABLED", 65536],
    ["/api/delivery/github-source/challenge", "HIVE_DELIVERY_GITHUB_SOURCE_ENABLED", 65536],
    ["/api/delivery/github-source", "HIVE_DELIVERY_GITHUB_SOURCE_ENABLED", 1152 * 1024],
    ["/api/delivery/source-publication/policy", "HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED", 65536],
    [
      "/api/delivery/source-publication/challenge",
      "HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED",
      65536,
    ],
    ["/api/delivery/source-publication", "HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED", 65536],
    ["/api/delivery/source-publication/state", "HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED", 16384],
  ] as const)("only explicitly enabled exact callback %s reaches route authentication", (path, flag, limit) => {
    expect(isHostCallbackTransport(request(path), "true")).toBe(false);
    expect(isHostCallbackTransport(request(path), "false", capabilities)).toBe(false);
    expect(isHostCallbackTransport(request(path), "true", capabilities)).toBe(true);
    for (const value of [undefined, false, "TRUE", "false"])
      expect(
        isHostCallbackTransport(request(path), "true", { ...capabilities, [flag]: value }),
      ).toBe(false);
    if (path.startsWith("/api/delivery/"))
      expect(
        isHostCallbackTransport(request(path), "true", {
          ...capabilities,
          HIVE_DELIVERY_MANAGER_ENABLED: "false",
        }),
      ).toBe(false);
    for (const suffix of ["/", "/extra", "?", "?anything=1"])
      expect(isHostCallbackTransport(request(path + suffix), "true", capabilities)).toBe(false);
    const rejectedHeaders: Record<string, string>[] = [
      { "Content-Type": "application/json", "Content-Length": String(limit + 1) },
      { "Content-Type": "application/json", Origin: base },
      { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      { "Content-Type": "application/json", "Next-Action": "action" },
      { "Content-Type": "application/json", Upgrade: "websocket" },
    ];
    for (const headers of rejectedHeaders)
      expect(isHostCallbackTransport(request(path, { headers }), "true", capabilities)).toBe(false);
    expect(isHostCallbackTransport(request(path, { method: "GET" }), "true", capabilities)).toBe(
      false,
    );
  });
});
