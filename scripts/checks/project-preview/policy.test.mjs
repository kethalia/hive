import assert from "node:assert/strict";
import test from "node:test";
import { createBudget, ORIGIN, parseScope, permitted, TARGET } from "./policy.mjs";

const scope = {
  schemaVersion: 1,
  sourceRevision: "a".repeat(40),
  ...TARGET,
  preflightDigest: "b".repeat(64),
  expectedAppVersion: "test",
  expectedAppBuild: "test-build",
  priorForwarded: 12,
};
const open = JSON.stringify({
  workspaceId: scope.workspaceId,
  repositoryId: scope.repositoryId,
  providerAccountId: scope.providerAccountId,
  requestId: "20000000-0000-4000-8000-000000000001",
});
test("phase A permits fixed discovery, exact enrollment and no task/native/provider effects", () => {
  assert(
    permitted(
      scope,
      `${ORIGIN}/api/projects?workspaceId=${scope.workspaceId}&page=1&perPage=100`,
      "GET",
    ),
  );
  assert(permitted(scope, `${ORIGIN}/api/projects/open`, "POST", {}, open));
  for (const path of [
    "/api/projects/x/tasks/start",
    "/api/projects/x/tasks/status",
    "/api/projects/x/session-grant",
    "/api/projects/x/terminal-grant",
    "/api/notifications/sources",
    "/api/auth/terminal-ticket",
    "/ws",
    "/api/delivery/tasks",
  ])
    for (const method of ["GET", "POST"])
      assert(!permitted(scope, ORIGIN + path, method, {}, "{}"));
  assert(!permitted(scope, "https://github.com/kethalia/hive", "GET"));
  assert(permitted(scope, `${ORIGIN}/?_rsc=normal-prefetch`, "GET"));
  assert(!permitted(scope, `${ORIGIN}/?unknown=value`, "GET"));
  assert(!permitted(scope, `${ORIGIN}/?_rsc=one&_rsc=two`, "GET"));
});
test("binds repository account/workspace and refuses unknown or duplicate selectors", () => {
  for (const data of [
    { ...JSON.parse(open), workspaceId: "30000000-0000-4000-8000-000000000001" },
    { ...JSON.parse(open), providerAccountId: "789" },
    { ...JSON.parse(open), repositoryId: "789" },
    { ...JSON.parse(open), clone: true },
  ])
    assert(!permitted(scope, `${ORIGIN}/api/projects/open`, "POST", {}, JSON.stringify(data)));
  assert(
    !permitted(
      scope,
      `${ORIGIN}/api/projects?workspaceId=${scope.workspaceId}&page=1&page=2&perPage=100`,
      "GET",
    ),
  );
  assert(
    !permitted(
      scope,
      `${ORIGIN}/api/projects?workspaceId=${scope.workspaceId}&page=5&perPage=100`,
      "GET",
    ),
  );
  assert(!permitted(scope, `${ORIGIN}/workspaces`, "POST", { "Next-Action": "a" }, "{}"));
});
test("one login/open counted before dispatch and cleanup owns the reserved last slot", () => {
  const budget = createBudget({ ...scope, priorForwarded: 196 }, () => 0);
  assert(
    budget.reserve(`${ORIGIN}/api/auth/login`, "POST", {}, '{"email":"test","password":"private"}'),
  );
  assert(
    !budget.reserve(
      `${ORIGIN}/api/auth/login`,
      "POST",
      {},
      '{"email":"test","password":"private"}',
    ),
  );
  assert(budget.reserve(`${ORIGIN}/api/projects/open`, "POST", {}, open));
  assert(!budget.reserve(`${ORIGIN}/api/projects/open`, "POST", {}, open));
  assert(budget.reserve(`${ORIGIN}/api/app-version`, "GET"));
  assert(!budget.reserve(`${ORIGIN}/api/app-version`, "GET"));
  assert(budget.reserveCleanup());
  assert(!budget.reserveCleanup());
  assert.equal(budget.snapshot().cumulativeForwarded, 200);
});
test("bounded pagination, clock and aggregate prior count cannot reset on retry", () => {
  let now = 0;
  const budget = createBudget({ ...scope, priorForwarded: 10 }, () => now, { durationMs: 100 });
  const url = `${ORIGIN}/api/projects?workspaceId=${scope.workspaceId}&page=1&perPage=100`;
  for (let i = 0; i < 4; i++) assert(budget.reserve(url, "GET"));
  assert(!budget.reserve(url, "GET"));
  now = 100;
  assert(!budget.reserveCleanup());
  assert.equal(budget.snapshot().cumulativeForwarded, 14);
  assert.throws(() => createBudget({ ...scope, priorForwarded: 200 }, () => 0));
});
test("scope is exact and no arbitrary host/credential selector is accepted", () => {
  assert.throws(() => parseScope({ ...scope, origin: "https://other.example" }));
  assert(
    !permitted(scope, `${ORIGIN}/api/app-version`, "GET", { Authorization: "Bearer private" }),
  );
  assert(
    !permitted(
      scope,
      `${ORIGIN}/api/auth/login`,
      "POST",
      {},
      '{"email":"a","password":"b","url":"https://other.example"}',
    ),
  );
});
test("requires actual integer prior-spend scope and preserves cleanup headroom", () => {
  for (const value of [undefined, null, -1, 199, 200, 1.5, NaN, "12"])
    assert.throws(() => parseScope({ ...scope, priorForwarded: value }));
  assert.equal(
    createBudget({ ...scope, priorForwarded: 12 }, () => 0).snapshot().cumulativeForwarded,
    12,
  );
  assert.equal(
    createBudget({ ...scope, priorForwarded: 198 }, () => 0).snapshot().cumulativeForwarded,
    198,
  );
  const missing = { ...scope };
  delete missing.priorForwarded;
  assert.throws(() => parseScope(missing));
});
test("includes current reviewed layout/manifest icons and fonts without opening arbitrary public files", () => {
  for (const path of [
    "/icons/hive-mark.svg",
    "/apple-touch-icon.png",
    "/icons/icon-192.png",
    "/fonts/FiraCode-Regular.ttf",
  ])
    assert(permitted(scope, ORIGIN + path, "GET"));
  assert(!permitted(scope, `${ORIGIN}/icons/unreviewed.svg`, "GET"));
  assert(!permitted(scope, `${ORIGIN}/sw.js`, "GET"));
});
