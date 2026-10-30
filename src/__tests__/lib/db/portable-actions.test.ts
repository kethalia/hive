import { describe, expect, it } from "vitest";
import {
  isPortableDiscovery,
  isPortableServerAction,
  isUnsupportedPageMutation,
} from "../../../../deploy/cloudflare/app/portable-actions";

const id = `7f${"a".repeat(40)}`;
const manifest = { schemaVersion: 1, actions: { [id]: { paths: ["/workspaces"] } } };
const base = "https://hive.example";
function request(path = "/workspaces", init: RequestInit = {}) {
  return new Request(base + path, {
    method: "POST",
    headers: {
      "Next-Action": id,
      Origin: base,
      "Content-Type": "text/plain;charset=UTF-8",
    },
    ...init,
  });
}
describe("build-pinned portable action transport", () => {
  it("admits only the current build's exact reviewed page/action pair", () => {
    expect(isPortableServerAction(request(), manifest)).toBe(true);
    expect(isPortableServerAction(request(), { ...manifest, schemaVersion: 2 })).toBe(false);
    expect(isPortableServerAction(request(), { ...manifest, actions: {} })).toBe(false);
    for (const path of [
      "/",
      "/workspaces/",
      "/workspaces?",
      "/workspaces?x=1",
      "/%77orkspaces",
      "/api/discovery/workspaces",
    ])
      expect(isPortableServerAction(request(path), manifest)).toBe(false);
    expect(isPortableServerAction(request("/workspaces", { method: "GET" }), manifest)).toBe(false);
  });
  it.each([
    ["Next-Action", `7f${"b".repeat(40)}`],
    ["Next-Action", "constructor"],
    ["Origin", "https://foreign.example"],
    ["Origin", "null"],
    ["Sec-Fetch-Site", "cross-site"],
    ["Content-Type", "application/json"],
    ["Content-Encoding", "gzip"],
    ["Upgrade", "websocket"],
    ["Content-Length", "65537"],
    ["Content-Length", "-1"],
  ])("rejects incompatible browser transport %s=%s", (name, value) => {
    const initial = request();
    const headers = new Headers(initial.headers);
    headers.set(name, value);
    expect(isPortableServerAction(new Request(initial, { headers }), manifest)).toBe(false);
  });
  it("requires a browser origin and bounds declared bytes", () => {
    const initial = request();
    const headers = new Headers(initial.headers);
    headers.delete("Origin");
    expect(isPortableServerAction(new Request(initial, { headers }), manifest)).toBe(false);
    headers.set("Origin", base);
    headers.set("Content-Length", "65536");
    expect(isPortableServerAction(new Request(initial, { headers }), manifest)).toBe(true);
  });
});
it("headerless Next action forms and every unreviewed page mutation remain blocked", () => {
  expect(isUnsupportedPageMutation(request(), manifest)).toBe(false);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    for (const contentType of [
      "multipart/form-data; boundary=fixture",
      "application/x-www-form-urlencoded",
      "text/plain",
    ])
      expect(
        isUnsupportedPageMutation(
          request("/workspaces", { method, headers: { "Content-Type": contentType } }),
          manifest,
        ),
      ).toBe(true);
  expect(isUnsupportedPageMutation(request("/api/auth/login"), manifest)).toBe(false);
  for (const method of ["GET", "HEAD"])
    expect(
      isUnsupportedPageMutation(request("/workspaces", { method, headers: {} }), manifest),
    ).toBe(false);
});
it("only HTTP-based discovery reads leave the host-only compatibility gate", () => {
  for (const name of ["workspaces", "template-options", "agent", "templates"]) {
    expect(isPortableDiscovery(request(`/api/discovery/${name}`, { method: "GET" }))).toBe(true);
    expect(isPortableDiscovery(request(`/api/discovery/${name}`))).toBe(false);
  }
  for (const name of ["sessions", "repositories", "agent-tools", "workspaces/", "%77orkspaces"])
    expect(isPortableDiscovery(request(`/api/discovery/${name}`, { method: "GET" }))).toBe(false);
});
