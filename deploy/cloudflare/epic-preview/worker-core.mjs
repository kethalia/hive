import { timingSafeEqual } from "node:crypto";

const CODER_ORIGIN = "https://coder.kethalia.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const NEON_HOST = /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/;
const HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function response(status, body) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

export function validateConfig(env) {
  const invalid = [];
  if (env.CODER_URL !== CODER_ORIGIN) invalid.push("CODER_URL");
  if (!SHA.test(env.SOURCE_REVISION ?? "")) invalid.push("SOURCE_REVISION");
  if (!UUID.test(env.PROBE_RUN_ID ?? "")) invalid.push("PROBE_RUN_ID");
  if (!/^br-[a-z0-9-]+$/.test(env.NEON_PREVIEW_BRANCH_ID ?? ""))
    invalid.push("NEON_PREVIEW_BRANCH_ID");
  if (!NEON_HOST.test(env.NEON_PREVIEW_HOST ?? "")) invalid.push("NEON_PREVIEW_HOST");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(env.PREVIEW_BEARER_TOKEN ?? ""))
    invalid.push("PREVIEW_BEARER_TOKEN");
  if (
    typeof env.CODER_API_TOKEN !== "string" ||
    env.CODER_API_TOKEN.length < 16 ||
    env.CODER_API_TOKEN.length > 1024 ||
    /[\r\n]/.test(env.CODER_API_TOKEN)
  )
    invalid.push("CODER_API_TOKEN");
  try {
    const url = new URL(env.DATABASE_URL);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== env.NEON_PREVIEW_HOST ||
      !NEON_HOST.test(url.hostname) ||
      !url.username ||
      !url.password ||
      !/^\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
      (url.port && url.port !== "5432") ||
      url.hash
    )
      throw new Error();
  } catch {
    invalid.push("DATABASE_URL");
  }
  return invalid;
}

function authorized(request, token) {
  const actual = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function hasRequestBody(request) {
  if (request.body === null) return false;
  const reader = request.body.getReader();
  try {
    // HTTP runtimes may represent Content-Length: 0 as an empty stream.
    // Read only enough to distinguish empty from nonempty; never buffer input.
    for (let chunks = 0; chunks < 4; chunks++) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value.byteLength > 0) return true;
    }
    return true;
  } finally {
    await reader.cancel();
  }
}

const INSERT = `INSERT INTO hive_epic_preview.probes (run_id, phase, payload)
VALUES ($1::uuid, $2, $3::jsonb) ON CONFLICT (run_id, phase) DO NOTHING RETURNING run_id`;
const SELECT = `SELECT phase, payload FROM hive_epic_preview.probes
WHERE run_id = $1::uuid ORDER BY phase`;

export async function probeDatabase(sql, runId, revision) {
  const payload = JSON.stringify({ probe: "f02", revision });
  const commit = () =>
    sql.transaction([sql.query(INSERT, [runId, "commit", payload]), sql.query(SELECT, [runId])]);
  const [inserted, first] = await commit();
  const [replayed, second] = await commit();
  let expectedRollback = false;
  try {
    await sql.transaction([
      sql.query(INSERT, [runId, "rollback", payload]),
      sql.query("SELECT 1 / 0 AS deliberate_rollback", []),
    ]);
  } catch (error) {
    // An outage or authorization error is not evidence of database rollback.
    if (error?.code !== "22012") throw new Error("Rollback was not observed");
    expectedRollback = true;
  }
  const final = await sql.query(SELECT, [runId]);
  const committed = (rows) =>
    rows.length === 1 &&
    rows[0].phase === "commit" &&
    rows[0].payload?.probe === "f02" &&
    rows[0].payload?.revision === revision;
  if (
    inserted.length > 1 ||
    replayed.length !== 0 ||
    !committed(first) ||
    !committed(second) ||
    !committed(final) ||
    !expectedRollback
  )
    throw new Error("Transaction invariant failed");
  return {
    transport: "neon-http",
    transactionKind: "noninteractive-batch",
    committed: true,
    duplicateReplay: true,
    rollback: true,
    insertedThisRun: inserted.length === 1,
    retainedRowsForRun: final.length,
    prismaVerified: false,
    interactiveTransactionsVerified: false,
  };
}

export function createHandler({ createSql, probePrisma, fetchUpstream = fetch }) {
  return async (request, env) => {
    // Fail closed, including unknown paths, before any external request.
    const invalid = validateConfig(env);
    if (invalid.length)
      return response(503, { error: "PREVIEW_CONFIG_INCOMPLETE", fields: invalid });
    if (!authorized(request, env.PREVIEW_BEARER_TOKEN))
      return response(401, { error: "PREVIEW_AUTH_REQUIRED" });

    const url = new URL(request.url);
    if (url.search) return response(400, { error: "QUERY_PARAMETERS_NOT_SUPPORTED" });
    if (url.pathname === "/api/capabilities") {
      if (request.method !== "GET") return response(405, { error: "METHOD_NOT_ALLOWED" });
      return response(200, {
        schemaVersion: 1,
        sourceRevision: env.SOURCE_REVISION,
        runId: env.PROBE_RUN_ID,
        neonBranchId: env.NEON_PREVIEW_BRANCH_ID,
        scope: "isolated-api-probe",
        configuredCoderOrigin: CODER_ORIGIN,
        supportedProbes: [
          "coder-read-only-identity",
          "neon-http-transaction",
          "prisma-interactive-transaction",
        ],
        unverified: [
          "hive-auth",
          "framework-build",
          "prisma",
          "interactive-transactions",
          "workspace-operations",
          "terminal",
          "shared-native-thread",
          "background-jobs",
        ],
      });
    }
    if (url.pathname === "/api/probe/coder") {
      if (request.method !== "GET") return response(405, { error: "METHOD_NOT_ALLOWED" });
      try {
        const upstream = await fetchUpstream(`${CODER_ORIGIN}/api/v2/users/me`, {
          method: "GET",
          headers: { "Coder-Session-Token": env.CODER_API_TOKEN, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (!upstream.ok) return response(502, { error: "CODER_IDENTITY_REJECTED" });
        const user = await upstream.json();
        if (!UUID.test(user.id ?? "") || typeof user.username !== "string")
          return response(502, { error: "CODER_IDENTITY_INVALID" });
        return response(200, {
          sourceRevision: env.SOURCE_REVISION,
          coder: { authenticated: true, userId: user.id },
        });
      } catch {
        return response(502, { error: "CODER_IDENTITY_UNAVAILABLE" });
      }
    }
    if (url.pathname === "/api/probe/neon") {
      if (request.method !== "POST") return response(405, { error: "METHOD_NOT_ALLOWED" });
      // Fixed run identity caps durable data to one committed row per configured
      // revision/run. No caller SQL, parameters, arbitrary database or URLs.
      if (await hasRequestBody(request))
        return response(400, { error: "REQUEST_BODY_NOT_SUPPORTED" });
      try {
        const result = await probeDatabase(
          createSql(env.DATABASE_URL),
          env.PROBE_RUN_ID,
          env.SOURCE_REVISION,
        );
        return response(200, {
          sourceRevision: env.SOURCE_REVISION,
          runId: env.PROBE_RUN_ID,
          neon: result,
        });
      } catch {
        // Driver exceptions can contain SQL, endpoint details or credentials.
        return response(502, { error: "NEON_TRANSACTION_PROBE_FAILED" });
      }
    }
    if (url.pathname === "/api/probe/prisma") {
      if (request.method !== "POST") return response(405, { error: "METHOD_NOT_ALLOWED" });
      if (await hasRequestBody(request))
        return response(400, { error: "REQUEST_BODY_NOT_SUPPORTED" });
      try {
        const result = await probePrisma(env.DATABASE_URL, env.PROBE_RUN_ID, env.SOURCE_REVISION);
        return response(200, {
          sourceRevision: env.SOURCE_REVISION,
          runId: env.PROBE_RUN_ID,
          prisma: result,
        });
      } catch {
        return response(502, { error: "PRISMA_TRANSACTION_PROBE_FAILED" });
      }
    }
    return response(404, { error: "NOT_FOUND" });
  };
}
