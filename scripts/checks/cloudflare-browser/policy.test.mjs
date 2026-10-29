import assert from "node:assert/strict";
import test from "node:test";
import { cleanupSession, createBudget, ORIGIN, permitted } from "./policy.mjs";

test("budget charges bootstrap/assets/login before network, hard stops at200", () => {
  const budget = createBudget(() => 0);
  let forwarded = 0;
  for (let i = 0; i < 220; i++) {
    const path =
      i === 0 ? "/__hive-preview/access" : i === 1 ? "/api/auth/login" : "/_next/static/chunk.js";
    if (budget.reserve(ORIGIN + path, i < 2 ? "POST" : "GET")) forwarded++;
  }
  assert.equal(forwarded, 199);
  assert.equal(budget.snapshot().blocked.budget, 21);
  assert.equal(budget.reserveCleanup(`${ORIGIN}/api/auth/logout`, "POST"), true);
  assert.equal(budget.snapshot().forwarded, 200);
  assert.equal(budget.reserveCleanup(`${ORIGIN}/api/auth/logout`, "POST"), false);
});
test("deadline and foreign/execute routes fail closed", () => {
  let now = 0;
  const budget = createBudget(() => now);
  for (const [url, method] of [
    ["https://evil.example/login", "GET"],
    [`${ORIGIN}/api/projects/x/tasks/start`, "POST"],
    [`${ORIGIN}/api/auth/terminal-ticket`, "POST"],
    [`${ORIGIN}/api/discovery/repositories`, "GET"],
    [`${ORIGIN}/api/discovery/workspaces`, "GET"],
    [`${ORIGIN}/api/delivery/tasks`, "POST"],
    [`${ORIGIN}/settings`, "POST"],
    [`${ORIGIN}/__hive-preview/access?token=x`, "POST"],
  ])
    assert.equal(budget.reserve(url, method), false);
  assert.equal(budget.snapshot().forwarded, 0);
  now = 180000;
  assert.equal(budget.reserve(`${ORIGIN}/login`, "GET"), false);
});
test("redirect targets cannot authorize foreign origin or project execution", () => {
  assert.equal(permitted(new URL("//evil.example", `${ORIGIN}/login`).href, "GET"), false);
  assert.equal(permitted(`${ORIGIN}/api/projects/x/session`, "GET"), false);
  assert.equal(permitted(`${ORIGIN}/workspaces?_rsc=abc`, "GET"), true);
});

test("one login only, including concurrent reservation and retry", () => {
  const budget = createBudget(() => 0);
  const attempts = Array.from({ length: 10 }, () =>
    budget.reserve(`${ORIGIN}/api/auth/login`, "POST"),
  );
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(budget.snapshot().loginPosts, 1);
  assert.equal(budget.reserveCleanup(`${ORIGIN}/api/auth/login`, "POST"), false);
});
test("failure cleanup gets reserved final slot, fixed endpoint and no redirects/retries", async () => {
  const budget = createBudget(() => 0);
  for (let i = 0; i < 199; i++) assert.equal(budget.reserve(`${ORIGIN}/login`, "GET"), true);
  assert.equal(budget.reserve(`${ORIGIN}/api/auth/logout`, "POST"), false);
  let disposed = false,
    sent = 0;
  const result = await cleanupSession(budget, {
    async post(url, options) {
      sent++;
      assert.equal(budget.snapshot().forwarded, 200);
      assert.equal(url, `${ORIGIN}/api/auth/logout`);
      assert.deepEqual(options.headers, { Origin: ORIGIN });
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.maxRetries, 0);
      return {
        status: () => 200,
        async dispose() {
          disposed = true;
        },
      };
    },
  });
  assert.deepEqual(result, { cleanupAttempted: true, cleanupSucceeded: true });
  assert.equal(sent, 1);
  assert.equal(disposed, true);
});
test("cleanup failure is safe and cannot spend network beyond deadline", async () => {
  let now = 0;
  const budget = createBudget(() => now);
  now = 180000;
  const result = await cleanupSession(budget, {
    post() {
      throw new Error("must not send");
    },
  });
  assert.deepEqual(result, { cleanupAttempted: true, cleanupSucceeded: false });
  assert.equal(budget.snapshot().forwarded, 0);
});
