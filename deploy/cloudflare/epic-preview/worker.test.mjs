import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandler, probeDatabase } from "./worker-core.mjs";

const env = {
  CODER_URL: "https://coder.kethalia.com",
  SOURCE_REVISION: "a".repeat(40),
  PROBE_RUN_ID: "11111111-1111-4111-8111-111111111111",
  NEON_PREVIEW_BRANCH_ID: "br-test-preview",
  NEON_PREVIEW_HOST: "ep-test.us-east-1.aws.neon.tech",
  DATABASE_URL: "postgresql://preview:synthetic-password@ep-test.us-east-1.aws.neon.tech/preview",
  PREVIEW_BEARER_TOKEN: "synthetic-preview-bearer-".padEnd(48, "x"),
  CODER_API_TOKEN: "synthetic-coder-api-token",
};
const request = (path, options = {}) =>
  new Request(`https://preview.invalid${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${env.PREVIEW_BEARER_TOKEN}`, ...options.headers },
  });
const unavailable = () => {
  throw new Error("External dependency should not be called");
};

test("missing configuration fails closed without external calls or secret values", async () => {
  const fetch = createHandler({ createSql: unavailable, fetchUpstream: unavailable });
  const result = await fetch(request("/api/capabilities"), {});
  assert.equal(result.status, 503);
  const body = await result.json();
  assert.equal(body.error, "PREVIEW_CONFIG_INCOMPLETE");
  assert.ok(body.fields.includes("DATABASE_URL"));
  assert.ok(body.fields.includes("CODER_API_TOKEN"));
});

test("unapproved Coder/database hosts never contact upstream", async () => {
  const fetch = createHandler({ createSql: unavailable, fetchUpstream: unavailable });
  for (const overrides of [
    { CODER_URL: "https://attacker.invalid" },
    { DATABASE_URL: "postgresql://preview:secret@127.0.0.1/preview" },
    { DATABASE_URL: "postgresql://preview:secret@ep-other.us-east-1.aws.neon.tech/preview" },
  ])
    assert.equal((await fetch(request("/api/probe/coder"), { ...env, ...overrides })).status, 503);
});

test("missing/wrong bearer token denies every route and makes no external call", async () => {
  const fetch = createHandler({ createSql: unavailable, fetchUpstream: unavailable });
  for (const authorization of ["", "Bearer wrong", `bearer ${env.PREVIEW_BEARER_TOKEN}`]) {
    for (const path of ["/api/capabilities", "/api/probe/coder", "/api/probe/neon"]) {
      const result = await fetch(request(path, { headers: { Authorization: authorization } }), env);
      assert.equal(result.status, 401);
      assert.equal(result.headers.get("Cache-Control"), "private, no-store");
    }
  }
});

test("capability artifact identifies remaining F02 gates and contains no credentials", async () => {
  const fetch = createHandler({ createSql: unavailable, fetchUpstream: unavailable });
  const result = await fetch(request("/api/capabilities"), env);
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.sourceRevision, env.SOURCE_REVISION);
  assert.equal(body.scope, "isolated-api-probe");
  assert.ok(body.unverified.includes("prisma"));
  assert.ok(body.unverified.includes("hive-auth"));
  const serialized = JSON.stringify(body);
  for (const secret of [env.CODER_API_TOKEN, env.DATABASE_URL, env.PREVIEW_BEARER_TOKEN])
    assert.ok(!serialized.includes(secret));
});

test("Coder probe only makes fixed identity GET and returns sanitized identity", async () => {
  let calls = 0;
  const fetch = createHandler({
    createSql: unavailable,
    fetchUpstream: async (url, options) => {
      calls++;
      assert.equal(url, "https://coder.kethalia.com/api/v2/users/me");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["Coder-Session-Token"], env.CODER_API_TOKEN);
      return Response.json({
        id: env.PROBE_RUN_ID,
        username: "test",
        email: "private@example.invalid",
        token: "private",
      });
    },
  });
  const result = await fetch(request("/api/probe/coder"), env);
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).coder, { authenticated: true, userId: env.PROBE_RUN_ID });
  assert.equal(calls, 1);
});

test("Coder failure bodies and thrown credentials are never reflected", async () => {
  for (const fetchUpstream of [
    async () => new Response(`failure ${env.CODER_API_TOKEN}`, { status: 401 }),
    async () => {
      throw new Error(`failure ${env.CODER_API_TOKEN}`);
    },
    async () => Response.json({ id: "invalid", username: "test" }),
  ]) {
    const fetch = createHandler({ createSql: unavailable, fetchUpstream });
    const result = await fetch(request("/api/probe/coder"), env);
    assert.equal(result.status, 502);
    assert.ok(!(await result.text()).includes(env.CODER_API_TOKEN));
  }
});

test("caller cannot supply SQL, URLs, run IDs or mutation methods", async () => {
  const fetch = createHandler({ createSql: unavailable, fetchUpstream: unavailable });
  for (const [path, options, expected] of [
    ["/api/probe/coder?url=https://attacker.invalid", {}, 400],
    ["/api/probe/coder", { method: "POST" }, 405],
    ["/api/probe/neon", {}, 405],
    ["/api/probe/neon", { method: "POST", body: '{"sql":"DROP TABLE probes"}' }, 400],
    ["/api/execute", { method: "POST" }, 404],
  ])
    assert.equal((await fetch(request(path, options), env)).status, expected);
});

// Small atomic model, used to inject commit/replay/rollback failure modes. This
// is not integration evidence of Neon, its wire protocol, or workerd support.
function fakeSql({ rollbackCode = "22012", leakRollback = false, duplicateReplay = false } = {}) {
  let rows = [];
  const sql = {
    query: (query, params) => ({
      query,
      params,
      // biome-ignore lint/suspicious/noThenProperty: Match Neon's lazy query/transaction contract.
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => execute(this, rows))
          .then(resolve, reject);
      },
    }),
    transaction: async (queries) => {
      const snapshot = structuredClone(rows);
      try {
        const results = queries.map((query) => execute(query, snapshot));
        rows = snapshot;
        return results;
      } catch (error) {
        if (leakRollback) rows = snapshot;
        throw error;
      }
    },
  };
  function execute({ query, params }, state) {
    if (query.startsWith("SELECT 1 / 0"))
      throw Object.assign(new Error("Deliberate failure"), { code: rollbackCode });
    if (query.startsWith("SELECT phase"))
      return structuredClone(state.filter((row) => row.runId === params[0])).map(
        ({ phase, payload }) => ({ phase, payload }),
      );
    assert.ok(query.startsWith("INSERT INTO hive_epic_preview.probes"));
    const existing = state.some((row) => row.runId === params[0] && row.phase === params[1]);
    if (existing && !duplicateReplay) return [];
    state.push({ runId: params[0], phase: params[1], payload: JSON.parse(params[2]) });
    return [{ run_id: params[0] }];
  }
  return sql;
}

test("transaction probe observes commit, replay and rollback with fixed bounded data", async () => {
  const sql = fakeSql();
  const first = await probeDatabase(sql, env.PROBE_RUN_ID, env.SOURCE_REVISION);
  assert.equal(first.insertedThisRun, true);
  assert.equal(first.retainedRowsForRun, 1);
  assert.equal(first.rollback, true);
  assert.equal(first.prismaVerified, false);
  const second = await probeDatabase(sql, env.PROBE_RUN_ID, env.SOURCE_REVISION);
  assert.equal(second.insertedThisRun, false);
  assert.equal(second.retainedRowsForRun, 1);
});

test("network/auth failures cannot be mistaken for deliberate rollback", async () => {
  for (const rollbackCode of [undefined, "08006", "28000"]) {
    const sql = fakeSql({ rollbackCode: rollbackCode ?? "unknown" });
    await assert.rejects(
      probeDatabase(sql, env.PROBE_RUN_ID, env.SOURCE_REVISION),
      /Rollback was not observed/,
    );
  }
});

test("partial rollback and duplicate writes fail the acceptance invariant", async () => {
  for (const options of [{ leakRollback: true }, { duplicateReplay: true }])
    await assert.rejects(
      probeDatabase(fakeSql(options), env.PROBE_RUN_ID, env.SOURCE_REVISION),
      /Transaction invariant failed/,
    );
});

test("driver failures never leak connection strings through the Worker", async () => {
  const fetch = createHandler({
    createSql: () => {
      throw new Error(env.DATABASE_URL);
    },
  });
  const result = await fetch(request("/api/probe/neon", { method: "POST" }), env);
  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), { error: "NEON_TRANSACTION_PROBE_FAILED" });
});
