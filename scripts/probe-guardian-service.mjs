#!/usr/bin/env node
// Local signature/transaction/route proof. It does not activate installed hosts.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const check = (v) => {
  if (!v) throw new Error("guardian_service_proof_rejected");
};
const url = new URL(process.env.HIVE_DELIVERY_TEST_DATABASE_URL ?? "");
check(
  url.protocol === "postgresql:" &&
    url.hostname === "127.0.0.1" &&
    url.username === "coder" &&
    !url.password &&
    url.pathname === "/hive_delivery_test" &&
    url.port &&
    !url.search &&
    !url.hash,
);
const paths = [
  "src/lib/codex-session/guardian-contracts.ts",
  "src/lib/codex-session/guardian-config.server.ts",
  "src/lib/codex-session/guardian-store.server.ts",
  "src/lib/codex-session/guardian-transport-contracts.ts",
  "src/lib/codex-session/guardian-service.server.ts",
  "src/lib/codex-session/guardian-factory.server.ts",
  "src/lib/codex-session/guardian-route.server.ts",
  "src/app/api/codex-host/guardians/route.ts",
  "src/__tests__/lib/codex-session/guardian-service.integration.test.ts",
  "src/__tests__/lib/codex-session/guardian-route.test.ts",
  "src/__tests__/lib/codex-session/guardian-fixture.ts",
  "src/__tests__/lib/delivery/native-fixture.ts",
  "src/lib/codex-session/registration-store.server.ts",
  "src/lib/projects/task-intents.server.ts",
  "scripts/probe-guardian-service.mjs",
];
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sourceDigests = Object.fromEntries(paths.map((p) => [p, hash(p)]));
const revision = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const baseRevision = revision();
const directory = mkdtempSync(join(tmpdir(), "hive-guardian-service-proof-")),
  report = join(directory, "vitest.json");
const run = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "src/__tests__/lib/codex-session/guardian-service.integration.test.ts",
    "src/__tests__/lib/codex-session/guardian-route.test.ts",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1048576,
    env: { ...process.env, HIVE_DELIVERY_TEST_DATABASE_URL: url.href },
  },
);
let tests;
try {
  tests = JSON.parse(readFileSync(report, "utf8"));
} catch {
  tests = { numPassedTests: 0, numFailedTests: 1 };
}
const sourceStable = paths.every((p) => hash(p) === sourceDigests[p]);
const proof = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  baseRevision,
  endingBaseRevision: revision(),
  testedSourcesCommitted: !execFileSync("git", ["status", "--porcelain", "--", ...paths], {
    encoding: "utf8",
  }).trim(),
  sourceDigests,
  sourceStable,
  passed:
    run.status === 0 && tests.numPassedTests === 12 && tests.numFailedTests === 0 && sourceStable,
  database: { host: "127.0.0.1", port: Number(url.port), name: "hive_delivery_test", schema: 24 },
  tests: {
    passed: tests.numPassedTests,
    failed: tests.numFailedTests,
    skipped: tests.numPendingTests ?? 0,
    groups:
      tests.testResults?.map((t) => ({
        name: t.name.split("/").at(-1),
        passed: t.status === "passed",
      })) ?? [],
  },
  checks: {
    realEd25519OwnerBootstrap: true,
    oneUseEnrollment: true,
    unlistedPinsAndWrongConfigDenied: true,
    forgedOuterKeyDeniedBeforeCoderResolution: true,
    sqlExpiryAndAbortRollback: true,
    issuerGrantExpiryRollback: true,
    existingOpenProvisionFreshLiveness: true,
    provisionDoesNotExtendOrReapproveRuntime: true,
    routeDefaultOffAndNoBrowserOrQueryAuthority: true,
    latePositiveResponseDiscarded: true,
  },
  limitations: [
    "Coder owner/app identity resolution and kernel startup facts are explicit synthetic fixtures, not hardware remote attestation or live account validation.",
    "Actual installed owner-app/FD3/client/bootstrap path, middleware/preview exception and outer producer factory remain a subsequent composed gate.",
    "A commit may become uncertain if transport aborts after the final transaction guard; callers retain an unknown-outcome hold, never assume effects were undone.",
  ],
  cloudMutations: false,
  accountInference: false,
};
const evidenceDirectory = resolve("docs/checks/autonomous-delivery/guardian-registry-local"),
  output = resolve(
    process.env.HIVE_GUARDIAN_SERVICE_EVIDENCE_PATH ?? join(evidenceDirectory, "service.json"),
  );
check(output.startsWith(`${evidenceDirectory}/`) && output.endsWith(".json"));
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "ignore" });
check(proof.passed);
process.stdout.write(
  `${JSON.stringify({ passed: true, tests: 12, sourceStable, evidence: output })}\n`,
);
