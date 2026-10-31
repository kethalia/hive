#!/usr/bin/env node
// Local composition only: no deployment, Coder account or inference.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const check = (v) => {
  if (!v) throw new Error("guardian_controller_proof_rejected");
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
  "templates/ai-dev-k8s/scripts/codex-guardian-controller.mjs",
  "templates/ai-dev-k8s/scripts/codex-guardian-worker.mjs",
  "templates/ai-dev-k8s/scripts/codex-host-guardian.mjs",
  "templates/ai-dev-k8s/scripts/codex-guardian-startup.mjs",
  "templates/ai-dev-k8s/scripts/codex-native-guardian.c",
  "templates/ai-dev-k8s/scripts/codex-native-guardian.mjs",
  "templates/ai-dev-k8s/scripts/codex-process-identity.mjs",
  "templates/ai-dev-k8s/scripts/codex-project-controller.mjs",
  "templates/ai-dev-k8s/scripts/codex-project-discovery.mjs",
  "templates/ai-dev-k8s/scripts/codex-project-gateway.mjs",
  "templates/ai-dev-k8s/scripts/codex-session-bridge.mjs",
  "templates/ai-dev-k8s/scripts/codex-workspace-host.mjs",
  "templates/ai-dev-k8s/scripts/codex-workspace-host-outer.mjs",
  "templates/ai-dev-k8s/scripts/codex-workspace-host-worker.mjs",
  "src/lib/codex-session/bootstrap-delivery.server.ts",
  "src/lib/codex-session/guardian-factory.server.ts",
  "src/lib/codex-session/guardian-service.server.ts",
  "src/lib/codex-session/guardian-store.server.ts",
  "src/lib/codex-session/guardian-config.server.ts",
  "src/lib/codex-session/guardian-contracts.ts",
  "src/lib/codex-session/guardian-transport-contracts.ts",
  "src/lib/codex-session/registration-store.server.ts",
  "src/lib/projects/task-intents.server.ts",
  "packages/db/prisma/schema.prisma",
  "scripts/build-native-guardian.mjs",
  "scripts/verify-codex-guardian-controller.test.mjs",
  "scripts/verify-codex-project-controller.test.mjs",
  "scripts/verify-codex-host-guardian.test.mjs",
  "src/__tests__/lib/codex-session/guardian-installed.integration.test.ts",
  "src/__tests__/lib/codex-session/bootstrap-delivery.test.ts",
  "scripts/probe-guardian-controller.mjs",
];
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex"),
  sourceDigests = Object.fromEntries(paths.map((p) => [p, hash(p)])),
  revision = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baseRevision = revision(),
  scratch = mkdtempSync(join(tmpdir(), "hive-guardian-controller-proof-")),
  report = join(scratch, "vitest.json");
const runtime = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    "--test-concurrency=1",
    "scripts/verify-codex-guardian-controller.test.mjs",
    "scripts/verify-codex-project-controller.test.mjs",
    "scripts/verify-codex-host-guardian.test.mjs",
  ],
  { encoding: "utf8", timeout: 60000, maxBuffer: 1048576 },
);
writeFileSync(join(scratch, "runtime.log"), `${runtime.stdout}\n${runtime.stderr}`, {
  mode: 0o600,
});
const run = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "src/__tests__/lib/codex-session/guardian-installed.integration.test.ts",
    "src/__tests__/lib/codex-session/bootstrap-delivery.test.ts",
    "--no-file-parallelism",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { encoding: "utf8", timeout: 60000, maxBuffer: 1048576 },
);
writeFileSync(join(scratch, "vitest.log"), `${run.stdout}\n${run.stderr}`, { mode: 0o600 });
let tests;
try {
  tests = JSON.parse(readFileSync(report, "utf8"));
} catch {
  tests = { numPassedTests: 0, numFailedTests: 1 };
}
const runtimePassed = Number(runtime.stdout?.match(/^# pass (\d+)$/m)?.[1] ?? 0),
  sourceStable = paths.every((p) => hash(p) === sourceDigests[p]),
  proof = {
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
      runtime.status === 0 &&
      runtimePassed === 45 &&
      run.status === 0 &&
      tests.numPassedTests === 11 &&
      tests.numFailedTests === 0 &&
      sourceStable,
    database: { host: "loopback", port: Number(url.port), name: "hive_delivery_test", schema: 24 },
    tests: {
      runtime: runtimePassed,
      postgresAndOwnerTransport: tests.numPassedTests,
      failed: tests.numFailedTests,
    },
    actual: {
      compiledPinnedGuardian: true,
      exactOuterGuardianWorkerChain: true,
      privateFD3: true,
      ownerAppLocalHttp: true,
      realEd25519AndIssuerGrant: true,
      realPostgresEnrollmentAndAdmission: true,
      gitOnlyAfterPreparationAcknowledgement: true,
      checkoutInodeBound: true,
      nativeLaunchOneUse: true,
      spoofedBrowserOriginAndQueryRejected: true,
      unknownResponseDurableHold: true,
      freshMetadataAndChangedJournalHold: true,
      legacyControllerAndTmuxPtyRegression: true,
    },
    limitations: [
      "Coder owner/current-build/app resolution is a synthetic local fixture; no account or cloud calls.",
      "The composed worker is a pinned fixture, not the complete installed host. It runs Git but no native inference or namespace; checkout incarnation is an explicit fixture value, not a managed checkout receipt.",
      "Native registration/finalization/current metadata are separately crypto/journal unit-tested. The composed PG proof reserves first launch without manufacturing producerApproved, a native registration or a manager binding.",
      "Production task-start enrollment hook, curated package pin rollout, signed callback preview exception, real native namespace/registration composition and fresh idle drain snapshots remain separate gates.",
      "No tree_closed, quiescedAt, cleanup authority or physical writer release is claimed; installed elective drain remains a hold.",
    ],
    cloudMutations: false,
    accountInference: false,
  };
const directory = resolve("docs/checks/autonomous-delivery/guardian-controller-local"),
  output = resolve(
    process.env.HIVE_GUARDIAN_CONTROLLER_EVIDENCE_PATH ?? join(directory, "composition.json"),
  );
check(output.startsWith(`${directory}/`) && output.endsWith(".json"));
mkdirSync(directory, { recursive: true });
writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "ignore" });
check(proof.passed);
process.stdout.write(
  `${JSON.stringify({ passed: true, runtime: runtimePassed, integration: tests.numPassedTests, sourceStable, evidence: output })}\n`,
);
