import assert from "node:assert/strict";
import test from "node:test";
import {
  applySecurityHeaders,
  buildOriginRequest,
  isPublicCacheRequest,
  proxyRequest,
  rewriteOriginRedirect,
  scopeResponseCookiesToPublicHost,
} from "./worker.mjs";

test("caches only anonymous public GET requests", () => {
  const publicRequest = new Request("https://hive.example.com/");
  const privateRequest = new Request("https://hive.example.com/tasks", {
    headers: { cookie: "hive-session=secret" },
  });

  assert.equal(isPublicCacheRequest(publicRequest, new URL(publicRequest.url)), true);
  assert.equal(isPublicCacheRequest(privateRequest, new URL(privateRequest.url)), false);
});

test("sets edge security headers", () => {
  const headers = applySecurityHeaders(new Headers());

  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.match(headers.get("Strict-Transport-Security") ?? "", /includeSubDomains/);
});

test("routes with the origin host while preserving the public forwarded host", () => {
  const request = new Request("https://hive.example.com/tasks", {
    headers: {
      Host: "hive.example.com",
      "CF-Connecting-IP": "203.0.113.10",
      "X-Forwarded-For": "198.51.100.1",
      "X-Real-IP": "198.51.100.2",
    },
  });
  const originRequest = buildOriginRequest(
    request,
    new URL(request.url),
    new URL("https://hive-origin.example.net"),
  );

  assert.equal(originRequest.url, "https://hive-origin.example.net/tasks");
  assert.equal(originRequest.headers.get("Host"), null);
  assert.equal(originRequest.headers.get("X-Forwarded-Host"), "hive.example.com");
  assert.equal(originRequest.headers.get("X-Forwarded-For"), "203.0.113.10");
  assert.equal(originRequest.headers.get("X-Real-IP"), "203.0.113.10");
});

test("keeps protocol-relative request paths on the configured origin", () => {
  const request = new Request("https://hive.example.com//attacker.example/collect");
  const originRequest = buildOriginRequest(
    request,
    new URL(request.url),
    new URL("https://hive-origin.example.net"),
  );

  assert.equal(originRequest.url, "https://hive-origin.example.net//attacker.example/collect");
});

test("rewrites same-origin redirects to the public host", () => {
  const headers = new Headers({ Location: "https://hive-origin.example.net/login" });
  rewriteOriginRedirect(
    headers,
    new URL("https://hive-origin.example.net"),
    new URL("https://hive.example.com/tasks"),
  );
  assert.equal(headers.get("Location"), "https://hive.example.com/login");
});

test("scopes origin cookies to the public Worker host", () => {
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    "hive-session=expired; Path=/; Domain=.pr-157.hive.local.kethalia.com; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
  );
  headers.append(
    "Set-Cookie",
    "hive-session=signed; Path=/; Domain=.pr-157.hive.local.kethalia.com; Max-Age=604800; Secure; HttpOnly; SameSite=Lax",
  );

  scopeResponseCookiesToPublicHost(headers);

  assert.deepEqual(headers.getSetCookie(), [
    "hive-session=expired; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    "hive-session=signed; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Lax",
  ]);
});

test("rewrites cookie scope to a configured public parent domain", () => {
  const headers = new Headers({
    "Set-Cookie": "hive-session=signed; Path=/; Domain=.internal.example; Secure; HttpOnly",
  });

  scopeResponseCookiesToPublicHost(headers, ".hive.example.com");

  assert.match(headers.get("Set-Cookie") ?? "", /Domain=.hive.example.com/);
  assert.doesNotMatch(headers.get("Set-Cookie") ?? "", /internal\.example/);
});

test("returns 502 when the origin fetch fails", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("origin unavailable");
  });
  globalThis.caches = { default: { match: async () => null } };

  const response = await proxyRequest(
    new Request("https://hive.example.com/tasks"),
    { HIVE_ORIGIN: "https://hive-origin.example.net" },
    { waitUntil() {} },
  );

  assert.equal(response.status, 502);
});
