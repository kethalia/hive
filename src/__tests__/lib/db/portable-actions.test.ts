import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundPortableActionBody,
  isPortableDiscovery,
  isPortableServerAction,
  isUnsupportedPageMutation,
} from "../../../../deploy/cloudflare/app/portable-actions";

const id = `7f${"a".repeat(40)}`;
const manifest = {
  schemaVersion: 1,
  actions: { [id]: { paths: ["/workspaces"], maxBodyBytes: 65536 } },
};
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
  it("uses the build-pinned per-export cap, rejecting missing or unsupported manifest limits", () => {
    const large = {
      ...manifest,
      actions: { [id]: { paths: ["/workspaces"], maxBodyBytes: 786432 } },
    };
    const headers = new Headers(request().headers);
    headers.set("Content-Length", "524800");
    const input = new Request(request(), { headers });
    expect(isPortableServerAction(input, manifest)).toBe(false);
    expect(isPortableServerAction(input, large)).toBe(true);
    headers.set("Content-Length", "786433");
    expect(isPortableServerAction(new Request(request(), { headers }), large)).toBe(false);
    for (const maxBodyBytes of [0, 1, 1048576, NaN])
      expect(
        isPortableServerAction(request(), {
          ...manifest,
          actions: { [id]: { paths: ["/workspaces"], maxBodyBytes } },
        }),
      ).toBe(false);
  });
});

afterEach(() => vi.useRealTimers());
function streamed(body: ReadableStream<Uint8Array>, patch: RequestInit = {}) {
  const init: RequestInit & { duplex: "half" } = { ...patch, body, duplex: "half" };
  return new Request(request(), init);
}
describe("actual portable action body boundary", () => {
  it("preserves exact bytes, Next headers and caller cancellation on a bounded request", async () => {
    const controller = new AbortController();
    const input = request("/workspaces", {
      body: '[{"paths":["é.ts","a\\nb"]}]',
      signal: controller.signal,
    });
    const result = await boundPortableActionBody(input, manifest);
    expect(result).toBeInstanceOf(Request);
    if (!(result instanceof Request)) throw new Error("unexpected rejection");
    expect(await result.text()).toBe('[{"paths":["é.ts","a\\nb"]}]');
    expect([...result.headers]).toEqual([...input.headers]);
    controller.abort();
    expect(result.signal.aborted).toBe(true);
  });
  it("admits a valid large path batch only with its larger manifest cap", async () => {
    const large = {
      ...manifest,
      actions: { [id]: { paths: ["/workspaces"], maxBodyBytes: 786432 } },
    };
    const body = JSON.stringify([{ paths: Array(128).fill("p".repeat(4096)) }]);
    expect(body.length).toBeGreaterThan(65536);
    const result = await boundPortableActionBody(request("/workspaces", { body }), large);
    expect(result).toBeInstanceOf(Request);
    if (!(result instanceof Request)) throw new Error("unexpected rejection");
    expect(await result.text()).toBe(body);
    expect(
      (await boundPortableActionBody(request("/workspaces", { body }), manifest)) instanceof
        Response,
    ).toBe(true);
  });
  it.each([
    undefined,
    "1",
  ])("caps streamed bytes with declared length %s and cancels", async (length) => {
    let cancelled = false;
    const headers = new Headers(request().headers);
    if (length) headers.set("Content-Length", length);
    const input = streamed(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(40000));
          c.enqueue(new Uint8Array(40000));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers },
    );
    const result = await boundPortableActionBody(input, manifest);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(cancelled).toBe(true);
  });
  it("rejects a mismatched declared length instead of forwarding misleading framing", async () => {
    const headers = new Headers(request().headers);
    headers.set("Content-Length", "1");
    const result = await boundPortableActionBody(
      request("/workspaces", { headers, body: "xx" }),
      manifest,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    const missing = await boundPortableActionBody(request("/workspaces", { headers }), manifest);
    expect(missing).toBeInstanceOf(Response);
    expect((missing as Response).status).toBe(400);
  });
  it("bounds a stalled body even when stream cancellation never settles", async () => {
    vi.useFakeTimers();
    const input = streamed(new ReadableStream({ cancel: () => new Promise(() => {}) }));
    const pending = boundPortableActionBody(input, manifest);
    await vi.advanceTimersByTimeAsync(5101);
    const result = await pending;
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(408);
  });
  it("rejects caller cancellation and excessive empty chunks", async () => {
    const controller = new AbortController();
    const input = streamed(new ReadableStream(), { signal: controller.signal });
    const pending = boundPortableActionBody(input, manifest);
    controller.abort();
    expect(((await pending) as Response).status).toBe(408);
    const empty = streamed(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array()) }));
    expect(((await boundPortableActionBody(empty, manifest)) as Response).status).toBe(400);
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

it("admits agent discovery only with the scoped agent bridge enabled", () => {
  const incoming = request("/api/discovery/agent-tools", { method: "GET" });
  expect(isPortableDiscovery(incoming)).toBe(false);
  expect(isPortableDiscovery(incoming, true)).toBe(true);
  expect(isPortableDiscovery(request("/api/discovery/agent-tools", { method: "POST" }), true)).toBe(
    false,
  );
});
