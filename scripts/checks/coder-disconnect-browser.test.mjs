import test from "node:test";
import assert from "node:assert/strict";
import {
  allowDisconnectRequest,
  newRequestPolicy,
  parseDisconnectInput,
  dispatchSyntheticFocus,
} from "./coder-disconnect-browser.mjs";

const origin = "https://codex-delivery-system-design-hive.b00ste.workers.dev";
const id = "10000000-0000-4000-8000-000000000001";
const cookie = { name: "__Host-hive-session", value: `${id}.1800000000000.${"a".repeat(64)}` };
test("input accepts only the one Hive cookie and bounded metadata", () => {
  assert.deepEqual(
    parseDisconnectInput(JSON.stringify({ schemaVersion: 1, budgetReserved: 100, cookie })),
    cookie,
  );
  for (const value of [
    { schemaVersion: 1, budgetReserved: 100, cookie, accessToken: "forbidden" },
    { schemaVersion: 1, budgetReserved: 100, cookie: { ...cookie, name: "Coder-Session-Token" } },
    { schemaVersion: 1, budgetReserved: 100, cookie: { ...cookie, value: "invalid" } },
  ])
    assert.throws(() => parseDisconnectInput(JSON.stringify(value)));
  assert.throws(() => parseDisconnectInput("x".repeat(8193)));
});
test("GET budget stops at100 and blocks provider/OAuth navigation", () => {
  const p = newRequestPolicy();
  for (let i = 0; i < 100; i++)
    assert.equal(
      allowDisconnectRequest(p, { url: origin + "/_next/static/a.js", method: "GET" }),
      true,
    );
  assert.equal(allowDisconnectRequest(p, { url: origin + "/workspaces", method: "GET" }), false);
  assert.equal(p.gets, 100);
  assert.equal(
    allowDisconnectRequest(newRequestPolicy(), {
      url: "https://coder.kethalia.com/oauth2/authorize",
      method: "GET",
    }),
    false,
  );
  assert.equal(
    allowDisconnectRequest(newRequestPolicy(), {
      url: origin + "/api/auth/coder/start",
      method: "GET",
    }),
    false,
  );
});
test("only one armed exact-generation disconnect POST is allowed", () => {
  const p = newRequestPolicy();
  p.expected = { credentialId: id, version: 3 };
  p.armed = true;
  const request = {
    url: origin + "/api/auth/coder/disconnect",
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify(p.expected),
  };
  assert.equal(allowDisconnectRequest(p, request), true);
  assert.equal(allowDisconnectRequest(p, request), false);
  assert.equal(p.posts, 1);
  assert.equal(p.postAttempts, 2);
});
test("cancel, foreign generation/owner fields, other mutations and query overrides cannot submit", () => {
  for (const request of [
    {
      url: origin + "/api/auth/coder/disconnect",
      body: JSON.stringify({ credentialId: id, version: 4 }),
    },
    {
      url: origin + "/api/auth/coder/disconnect",
      body: JSON.stringify({ credentialId: id, version: 3, userId: "foreign" }),
    },
    {
      url: origin + "/api/auth/coder/disconnect?owner=foreign",
      body: JSON.stringify({ credentialId: id, version: 3 }),
    },
    { url: origin + "/api/auth/logout", body: "{}" },
  ]) {
    const p = newRequestPolicy();
    p.expected = { credentialId: id, version: 3 };
    p.armed = true;
    assert.equal(
      allowDisconnectRequest(p, { method: "POST", contentType: "application/json", ...request }),
      false,
    );
    assert.equal(p.posts, 0);
  }
  const p = newRequestPolicy();
  p.expected = { credentialId: id, version: 3 };
  assert.equal(
    allowDisconnectRequest(p, {
      url: origin + "/api/auth/coder/disconnect",
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(p.expected),
    }),
    false,
  );
  assert.equal(
    allowDisconnectRequest(newRequestPolicy(), {
      url: origin + "/api/settings/window",
      method: "DELETE",
    }),
    false,
  );
});

// Pure in-memory event target: no Chrome, DOM runtime, HTTP, or application state.
test("synthetic focus uses Query's window visibility event without claiming native focus", async () => {
  const { runInNewContext } = await import("node:vm");
  const target = new EventTarget();
  let queryListenerCalls = 0;
  target.addEventListener("visibilitychange", () => {
    queryListenerCalls++;
  });
  const result = runInNewContext("(" + dispatchSyntheticFocus.toString() + ")()", {
    window: target,
    document: { visibilityState: "visible" },
    Event,
  });
  assert.equal(result.visibility, true);
  assert.equal(result.focus, true);
  assert.equal(result.documentVisible, true);
  assert.equal(queryListenerCalls, 1);
  const hidden = runInNewContext("(" + dispatchSyntheticFocus.toString() + ")()", {
    window: target,
    document: { visibilityState: "hidden" },
    Event,
  });
  assert.equal(hidden.documentVisible, false);
});
