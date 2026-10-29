import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const privateDirectory =
  process.env.HIVE_PREVIEW_CREDENTIAL_DIRECTORY ?? "/tmp/hive-epic-coder-auth";
// A fixed endpoint prevents accidentally forwarding the preview bearer elsewhere.
const origin = "https://hive-delivery-capability-preview.b00ste.workers.dev";
const results = [];
try {
  const expected = JSON.parse(
    await readFile(join(privateDirectory, "prepared-deployment.json"), "utf8"),
  );
  const bearer = (await readFile(join(privateDirectory, "preview-live-bearer"), "utf8")).trim();
  const call = async (path, method, authenticated, expectedStatus) => {
    assert.ok(results.length < 7, "Bounded preview request budget exhausted");
    const started = performance.now();
    const result = await fetch(`${origin}${path}`, {
      method,
      redirect: "error",
      headers: authenticated ? { Authorization: `Bearer ${bearer}` } : {},
      signal: AbortSignal.timeout(55_000),
    });
    const body = await result.json();
    results.push({
      path,
      method,
      authenticated,
      status: result.status,
      elapsedMs: Math.round(performance.now() - started),
      body,
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.headers.get("Cache-Control"), "private, no-store");
    if (authenticated) assert.equal(body.sourceRevision, expected.sourceRevision);
    return body;
  };
  await call("/api/capabilities", "GET", false, 401);
  const capabilities = await call("/api/capabilities", "GET", true, 200);
  assert.equal(capabilities.runId, expected.runId);
  assert.equal(capabilities.neonBranchId, "br-ancient-violet-b7pcun87");
  const coder = await call("/api/probe/coder", "GET", true, 200);
  assert.equal(coder.coder.authenticated, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = await call("/api/probe/prisma", "POST", true, 200);
    assert.equal(body.runId, expected.runId);
    assert.equal(body.prisma.insertedThisRun, attempt === 0);
    assert.equal(body.prisma.runtimeRoleRestricted, true);
    assert.equal(body.prisma.rollback, true);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = await call("/api/probe/neon", "POST", true, 200);
    assert.equal(body.runId, expected.runId);
    assert.equal(body.neon.retainedRowsForRun, 1);
    assert.equal(body.neon.duplicateReplay, true);
    assert.equal(body.neon.rollback, true);
  }
  await writeFile(
    join(directory, "live-evidence.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        ...expected,
        origin,
        scriptedRequests: results.length,
        maximumAuthorizedRequests: 20,
        results,
        f02Complete: false,
        limitations: [
          "fixture schema only",
          "framework and Hive authentication unverified",
          "workspace/terminal/shared native thread unverified",
        ],
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify({
      passed: true,
      scriptedRequests: results.length,
      sourceRevision: expected.sourceRevision,
      artifact: join(directory, "live-evidence.json"),
    }),
  );
} catch {
  // Error messages can contain signed upstream URLs. Preserve only sanitized
  // response bodies/statuses from our fixed Worker, not raw fetch/driver errors.
  await writeFile(
    join(directory, "live-failure-evidence.json"),
    `${JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        scriptedRequests: results.length,
        results,
        passed: false,
      },
      null,
      2,
    )}\n`,
  );
  console.error(
    "Bounded preview check failed. Sanitized response evidence saved; no credentials printed.",
  );
  process.exitCode = 1;
}
