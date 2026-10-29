import assert from "node:assert/strict";
import test from "node:test";
import { createBudget, ORIGIN, permitted } from "./policy.mjs";

test("budget charges bootstrap/assets/login before network, hard stops at200", () => {
  const budget = createBudget(() => 0);
  let forwarded = 0;
  for (let i = 0; i < 220; i++) {
    const path =
      i === 0 ? "/__hive-preview/access" : i === 1 ? "/api/auth/login" : "/_next/static/chunk.js";
    if (budget.reserve(ORIGIN + path, i < 2 ? "POST" : "GET")) forwarded++;
  }
  assert.equal(forwarded, 200);
  assert.equal(budget.snapshot().blocked.budget, 20);
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
