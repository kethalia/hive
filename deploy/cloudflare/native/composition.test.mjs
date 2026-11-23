import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getHivePublicOrigin } from "@hive/auth/hive-origin";
import { createNativeWorker } from "./composition.mjs";

const config = JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url)));
const preview = {
  ...config.previews.vars,
  DATABASE_URL:
    "postgresql://hive_accounts_runtime:fixture@localhost/hive_workspace_accounts_preview",
};
const production = {
  ...config.vars,
  DATABASE_URL: "postgresql://hive_production_runtime:fixture@localhost/hive_production",
};
const context = { waitUntil() {} };
const previewOrigin = "https://codex-projects-p05.hive-preview.kethalia.com";
const anotherOrigin = "https://another-branch.hive-preview.kethalia.com";
const worker = createNativeWorker({
  app: {
    async fetch(_request, env) {
      await Promise.resolve();
      assert.equal(getHivePublicOrigin(), env.HIVE_PUBLIC_ORIGIN);
      return env.AUTH_SERVICE.fetch("https://auth.internal/health");
    },
  },
  auth: {
    fetch(_request, env) {
      assert.equal(getHivePublicOrigin(), env.HIVE_PUBLIC_ORIGIN);
      return Response.json([env.HIVE_PUBLIC_ORIGIN, env.HIVE_DATABASE_NAME]);
    },
  },
});

test("native Previews use the trusted request origin for auth and application work", async () => {
  const origins = [previewOrigin, anotherOrigin, "https://c31c5176.hive-preview.kethalia.com"];
  const responses = await Promise.all(
    origins.map((origin) =>
      worker.fetch(
        new Request(origin, { headers: { "X-Forwarded-Host": "unrelated.example" } }),
        preview,
        context,
      ),
    ),
  );
  assert.deepEqual(
    await Promise.all(responses.map((response) => response.json())),
    origins.map((origin) => [origin, "hive_workspace_accounts_preview"]),
  );
});

test("Workers aliases redirect page loads to the same Preview's custom domain", async () => {
  const url = "https://codex-projects-p05-hive.b00ste.workers.dev/login?popup=1";
  for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(new Request(url, { method }), preview, context);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("Location"), `${previewOrigin}/login?popup=1`);
  }
  for (const init of [{ method: "POST" }, { headers: { upgrade: "websocket" } }]) {
    assert.equal((await worker.fetch(new Request(url, init), preview, context)).status, 403);
  }
});

test("native origin validation rejects unrelated hosts and production and preview substitutions", async () => {
  for (const origin of [
    "https://hive.kethalia.com",
    "https://hive-preview.kethalia.com",
    "https://branch.hive-preview.kethalia.com.example.org",
    "https://extra.branch.hive-preview.kethalia.com",
    "https://branch.hive-preview.kethalia.com:8443",
    "http://branch.hive-preview.kethalia.com",
    "https://branch-hive.someone.workers.dev",
  ]) {
    assert.equal((await worker.fetch(new Request(origin), preview, context)).status, 403);
  }
  assert.equal((await worker.fetch(new Request(previewOrigin), production, context)).status, 403);
  const response = await worker.fetch(
    new Request(production.HIVE_PUBLIC_ORIGIN),
    production,
    context,
  );
  assert.deepEqual(await response.json(), ["https://hive.kethalia.com", "hive_production"]);
});

test("database roles remain isolated at the native Worker boundary", async () => {
  for (const env of [
    { ...preview, DATABASE_URL: undefined },
    { ...preview, DATABASE_URL: production.DATABASE_URL },
    { ...preview, HIVE_PUBLIC_ORIGIN: production.HIVE_PUBLIC_ORIGIN },
    { ...production, DATABASE_URL: preview.DATABASE_URL },
    { ...production, HIVE_NATIVE_MODE: "bootstrap" },
    { ...production, HIVE_DATABASE_ROLE: preview.HIVE_DATABASE_ROLE },
  ]) {
    assert.equal((await worker.fetch(new Request(previewOrigin), env, context)).status, 503);
  }
});

const htmlWorker = createNativeWorker({
  app: {
    fetch(request) {
      const path = new URL(request.url).pathname;
      const policy =
        path === "/api/private"
          ? "default-src 'none'; frame-ancestors 'none'"
          : "default-src 'self'; frame-ancestors 'self'; frame-src 'self'; object-src 'none'";
      return new Response("<main>Hive</main>", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": policy,
          "X-Frame-Options": "SAMEORIGIN",
        },
      });
    },
  },
  auth: {},
});

test("only the launcher document allows its exact preview origin", async () => {
  const launch = await htmlWorker.fetch(
    new Request(`${production.HIVE_PUBLIC_ORIGIN}/app-preview/codex-projects-p05`),
    production,
    context,
  );
  assert.equal(
    launch.headers.get("Content-Security-Policy"),
    `default-src 'self'; frame-ancestors 'self'; frame-src ${previewOrigin}; object-src 'none'`,
  );
  assert.equal(launch.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(launch.headers.get("Cache-Control"), "private, no-store");
  for (const path of ["/settings", "/app-preview/extra.example", "/app-preview/a/b"]) {
    const document = await htmlWorker.fetch(
      new Request(production.HIVE_PUBLIC_ORIGIN + path),
      production,
      context,
    );
    assert.match(document.headers.get("Content-Security-Policy"), /frame-src 'self';/);
  }
});

test("native preview pages can be framed by Hive while custom API framing policy is kept", async () => {
  for (const path of ["/workspaces", "/login"]) {
    const previewDocument = await htmlWorker.fetch(
      new Request(previewOrigin + path),
      preview,
      context,
    );
    assert.match(
      previewDocument.headers.get("Content-Security-Policy"),
      /frame-ancestors 'self' https:\/\/hive\.kethalia\.com;/,
    );
    assert.equal(previewDocument.headers.get("X-Frame-Options"), null);
  }
  const privateDocument = await htmlWorker.fetch(
    new Request(`${previewOrigin}/api/private`),
    preview,
    context,
  );
  assert.match(privateDocument.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(privateDocument.headers.get("X-Frame-Options"), "SAMEORIGIN");
});
