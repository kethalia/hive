import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createFetchGuard,
  LIMITS,
  parsePlan,
  safeFailureCode,
} from "./probe-workspace-runtime-identity.mjs";

const plan = () => ({
  schemaVersion: 1,
  workspaceId: randomUUID(),
  ownerId: randomUUID(),
  templateId: randomUUID(),
  templateVersionId: randomUUID(),
  buildId: randomUUID(),
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageSourceSha: "b".repeat(40),
  helperSha256: "c".repeat(64),
  readArchiveSha256: "d".repeat(64),
  readManifestSha256: "e".repeat(64),
  hostArchiveSha256: "f".repeat(64),
  hostManifestSha256: "0".repeat(64),
  hiveOrigin: "https://hive.example.test",
  githubAccountId: "123",
  repositoryId: "456",
  expectedRefSha: "1".repeat(40),
  projectsRoot: "/home/coder",
  sessionName: "existing-readonly",
  expectedCwd: "/home/coder",
});
const coderHeaders = { "Coder-Session-Token": "fixture-token" };
test("acceptance plan requires exact build, component digests and existing read-only session", () => {
  const p = plan();
  assert.equal(parsePlan(p), p);
  for (const patch of [
    { extra: true },
    { schemaVersion: true },
    { workspaceId: "other" },
    { imageDigest: "latest" },
    { expectedRefSha: "main" },
    { projectsRoot: "/" },
    { sessionName: "git-clone-reserved" },
    { expectedCwd: "/home/coder/../outside" },
  ])
    assert.throws(() => parsePlan({ ...p, ...patch }));
});
test("transport rejects arbitrary provider writes and app routes before sending credentials", async () => {
  const p = plan();
  let calls = 0;
  const guard = createFetchGuard(p, "fixture-token", new AbortController().signal, async () => {
    calls++;
    return new Response(null, { status: 200 });
  });
  guard.add({ appOrigin: "https://host.example.test", agentId: randomUUID() }, "host");
  for (const [url, init] of [
    ["https://coder.kethalia.com/api/v2/users/me/keys", { method: "POST", headers: coderHeaders }],
    ["https://host.example.test/projects/open", { method: "POST", headers: {} }],
    ["https://host.example.test/projects/discover", { method: "POST", headers: coderHeaders }],
    ["https://attacker.example.test/", { headers: coderHeaders }],
    [
      `https://coder.kethalia.com/api/v2/workspaces/${p.workspaceId}?different=1`,
      { headers: coderHeaders },
    ],
  ])
    await assert.rejects(guard.fetch(url, { ...init, redirect: "manual" }));
  assert.equal(calls, 0);
  assert.equal(guard.counts.blocked, 5);
});
test("only bounded Coder reads are counted and a spent budget stops before another request", async () => {
  const p = plan();
  let calls = 0;
  const guard = createFetchGuard(p, "fixture-token", new AbortController().signal, async () => {
    calls++;
    return new Response(null, { status: 200 });
  });
  for (let n = 0; n < LIMITS.http; n++)
    await guard.fetch(`https://coder.kethalia.com/api/v2/workspaces/${p.workspaceId}`, {
      headers: coderHeaders,
      redirect: "manual",
    });
  await assert.rejects(
    guard.fetch(`https://coder.kethalia.com/api/v2/workspaces/${p.workspaceId}`, {
      headers: coderHeaders,
      redirect: "manual",
    }),
    /http_budget_exhausted/,
  );
  assert.equal(calls, LIMITS.http);
  assert.equal(guard.counts.total, LIMITS.http);
});
test("signed read transport excludes owner headers and records only fixed status categories", async () => {
  const p = plan(),
    binding = { appOrigin: "https://read.example.test", agentId: randomUUID() };
  let calls = 0;
  const guard = createFetchGuard(p, "fixture-token", new AbortController().signal, async () => {
    calls++;
    return new Response(null, { status: 200 });
  });
  guard.add(binding, "read");
  const claims = {
      aud: binding.appOrigin,
      binding: { workspaceId: p.workspaceId, buildId: p.buildId, agentId: binding.agentId },
      scope: "workspace:read:v1",
      request: { operation: "sessions" },
    },
    body = JSON.stringify({
      ticket: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
    }),
    headers = { Cookie: `coder_subdomain_app_session_token_${"a".repeat(32)}=fixture-cookie` };
  await guard.fetch(`${binding.appOrigin}/workspace/read`, {
    method: "POST",
    redirect: "manual",
    headers,
    body,
  });
  assert.equal(calls, 1);
  assert.deepEqual(guard.statuses, { "readPost:200": 1 });
  await assert.rejects(
    guard.fetch(`${binding.appOrigin}/workspace/read`, {
      method: "POST",
      redirect: "manual",
      headers: { ...headers, Authorization: "Bearer must-not-forward" },
      body,
    }),
  );
  assert.equal(calls, 1);
  assert(!JSON.stringify(guard.statuses).includes("fixture-cookie"));
});
test("failure evidence never copies arbitrary exception or token strings", () => {
  assert.equal(
    safeFailureCode(new Error(`private-token-${"a".repeat(64)}`)),
    "bounded_probe_failed",
  );
  assert.equal(safeFailureCode(new Error("a".repeat(64))), "bounded_probe_failed");
  assert.equal(
    safeFailureCode(new Error("workspace_identity_changed")),
    "workspace_identity_changed",
  );
});
