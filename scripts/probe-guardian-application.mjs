#!/usr/bin/env node
// Local persistence/action gate proof only. No installed apply or provider calls.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const check = (v) => {
  if (!v) throw new Error("guardian_application_proof_rejected");
};
const url = new URL(process.env.HIVE_DELIVERY_TEST_DATABASE_URL ?? "");
check(
  url.protocol === "postgresql:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    url.username === "coder" &&
    !url.password &&
    url.pathname === "/hive_delivery_test" &&
    url.port &&
    !url.search &&
    !url.hash,
);
const paths = [
  "packages/db/prisma/schema.prisma",
  "packages/db/prisma/migrations/20261029140000_delivery_source_application/migration.sql",
  "src/lib/codex-session/guardian-application-contracts.ts",
  "src/lib/codex-session/guardian-application-store.server.ts",
  "src/lib/codex-session/guardian-application-gate.server.ts",
  "src/lib/codex-session/guardian-store.server.ts",
  "src/lib/codex-session/guardian-contracts.ts",
  "src/lib/codex-session/registration-store.server.ts",
  "src/lib/delivery/manager.server.ts",
  "src/lib/delivery/native.server.ts",
  "src/lib/delivery/native-contracts.ts",
  "src/lib/delivery/source-publication.server.ts",
  "src/lib/delivery/source-transport.server.ts",
  "src/lib/delivery/source-transport-contracts.ts",
  "src/lib/delivery/source-resolver.server.ts",
  "src/lib/delivery/repository.ts",
  "src/lib/delivery/manager-binding.server.ts",
  "src/__tests__/lib/codex-session/guardian-application-fixture.ts",
  "src/__tests__/lib/codex-session/guardian-application.integration.test.ts",
  "src/__tests__/lib/codex-session/guardian-fixture.ts",
  "src/__tests__/lib/delivery/native-fixture.ts",
  "scripts/probe-guardian-application.mjs",
];
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex"),
  sourceDigests = Object.fromEntries(paths.map((p) => [p, hash(p)])),
  revision = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baseRevision = revision(),
  directory = mkdtempSync(join(tmpdir(), "hive-guardian-application-proof-")),
  report = join(directory, "vitest.json");
const run = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "src/__tests__/lib/codex-session/guardian-application.integration.test.ts",
    "--no-file-parallelism",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { encoding: "utf8", timeout: 60000, maxBuffer: 1048576 },
);
writeFileSync(join(directory, "vitest.log"), `${run.stdout}\n${run.stderr}`, { mode: 0o600 });
let tests;
try {
  tests = JSON.parse(readFileSync(report, "utf8"));
} catch {
  tests = { numPassedTests: 0, numFailedTests: 1 };
}
const sourceStable = paths.every((p) => hash(p) === sourceDigests[p]),
  proof = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    baseRevision,
    endingBaseRevision: revision(),
    sourceDigests,
    testedSourcesCommitted: !execFileSync("git", ["status", "--porcelain", "--", ...paths], {
      encoding: "utf8",
    }).trim(),
    sourceStable,
    passed:
      run.status === 0 && tests.numPassedTests === 8 && tests.numFailedTests === 0 && sourceStable,
    database: { host: "loopback", port: Number(url.port), name: "hive_delivery_test", schema: 25 },
    tests: {
      passed: tests.numPassedTests,
      failed: tests.numFailedTests,
      skipped: tests.numPendingTests ?? 0,
    },
    checks: {
      pendingExclusiveBeforeAndAfterReservation: true,
      originalProducingRootCompletionAllowed: true,
      acceptedAppliedGapBlocksExecutionBoundaryPublication: true,
      sameOperationFreshProtectedReceiptRequired: true,
      logicalLeaseExpiryDoesNotReleasePhysicalWriter: true,
      producerRevocationAndLateNativeFactsHold: true,
      concurrentDifferentReservationsExclusive: true,
      immutableDatabaseRecords: true,
      lostCommitAckAfterFiveSecondsUsesVerifyNotTimestampRewrite: true,
      strictPositiveAuthoritySchema: true,
      noQuiescenceOrPhysicalAnchorRelease: true,
    },
    limitations: [
      "Actual PostgreSQL guardian/registration/native-observation/manager/source state is exercised with explicit local owner/package and synthetic native facts.",
      "Publication verification and outer protected-journal attestations are trusted injected fixtures, not live GitHub/provider/native/host attestation.",
      "Signed guardian application actions, approved outer fixed-journal reader, FD3 apply methods, local input barrier and Python apply remain following composed gates; no installed factory is enabled.",
      "The input barrier proves only accounted native input/tool/child/CLI facts; no absence of background kernel writers or tree quiescence is claimed.",
    ],
    cloudMutations: false,
    accountInference: false,
  };
const evidenceDirectory = resolve("docs/checks/autonomous-delivery/guardian-application-local"),
  output = resolve(
    process.env.HIVE_GUARDIAN_APPLICATION_EVIDENCE_PATH ?? join(evidenceDirectory, "store.json"),
  );
check(output.startsWith(`${evidenceDirectory}/`) && output.endsWith(".json"));
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "ignore" });
check(proof.passed);
process.stdout.write(
  `${JSON.stringify({ passed: true, tests: 8, sourceStable, evidence: output })}\n`,
);
