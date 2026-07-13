import assert from "node:assert/strict";
import test from "node:test";
import { applySecurityHeaders, buildOriginRequest, isPublicCacheRequest } from "./worker.mjs";

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
    headers: { Host: "hive.example.com" },
  });
  const originRequest = buildOriginRequest(
    request,
    new URL(request.url),
    new URL("https://hive-origin.example.net"),
  );

  assert.equal(originRequest.url, "https://hive-origin.example.net/tasks");
  assert.equal(originRequest.headers.get("Host"), null);
  assert.equal(originRequest.headers.get("X-Forwarded-Host"), "hive.example.com");
});
