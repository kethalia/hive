#!/usr/bin/env node
// Bounded local signed actions / private outer transport proof. Never a cloud runner.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const check = (v) => {
  if (!v) throw new Error("guardian_application_actions_proof_rejected");
};
const mode = process.argv[2];
check(process.argv.length === 3 && ["--service", "--outer"].includes(mode));
const outer = mode === "--outer",
  root = "templates/ai-dev-k8s/scripts/";
const paths = outer
  ? [
      `${root}codex-guardian-controller.mjs`,
      `${root}codex-guardian-worker.mjs`,
      `${root}codex-host-guardian.mjs`,
      `${root}codex-workspace-host-outer.mjs`,
      `${root}codex-native-guardian.mjs`,
      `${root}codex-native-guardian.c`,
      `${root}codex-guardian-startup.mjs`,
      `${root}codex-process-identity.mjs`,
      "scripts/build-native-guardian.mjs",
      "scripts/verify-codex-guardian-controller.test.mjs",
      "scripts/verify-codex-host-guardian.test.mjs",
    ]
  : [
      "packages/db/prisma/schema.prisma",
      ...[
        "guardian-service.server.ts",
        "guardian-route.server.ts",
        "guardian-transport-contracts.ts",
        "guardian-application-contracts.ts",
        "guardian-application-store.server.ts",
        "guardian-store.server.ts",
        "guardian-contracts.ts",
        "guardian-config.server.ts",
        "registration-store.server.ts",
      ].map((p) => `src/lib/codex-session/${p}`),
      ...[
        "manager.server.ts",
        "native.server.ts",
        "native-contracts.ts",
        "source-publication.server.ts",
        "source-transport.server.ts",
        "source-resolver.server.ts",
        "repository.ts",
        "manager-binding.server.ts",
        "source-transport-contracts.ts",
      ].map((p) => `src/lib/delivery/${p}`),
      "src/lib/codex-session/guardian-application-gate.server.ts",
      "src/lib/codex-session/route.server.ts",
      "src/lib/projects/task-intents.server.ts",
      ...[
        "guardian-application-service.integration.test.ts",
        "guardian-application-fixture.ts",
        "guardian-fixture.ts",
      ].map((p) => `src/__tests__/lib/codex-session/${p}`),
      "src/__tests__/lib/delivery/native-fixture.ts",
    ];
paths.push("scripts/probe-guardian-application-actions.mjs");
let database;
if (!outer) {
  const u = new URL(process.env.HIVE_DELIVERY_TEST_DATABASE_URL ?? "");
  check(
    u.protocol === "postgresql:" &&
      ["127.0.0.1", "localhost"].includes(u.hostname) &&
      u.username === "coder" &&
      !u.password &&
      u.pathname === "/hive_delivery_test" &&
      u.port &&
      !u.search &&
      !u.hash,
  );
  database = {
    host: "loopback",
    port: Number(u.port),
    name: "hive_delivery_test",
    minimumSchema: 25,
  };
}
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex"),
  sourceDigests = Object.fromEntries(paths.map((p) => [p, hash(p)])),
  revision = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baseRevision = revision(),
  scratch = mkdtempSync(join(tmpdir(), "hive-application-actions-")),
  report = join(scratch, "vitest.json");
const run = spawnSync(
  outer ? process.execPath : "pnpm",
  outer
    ? [
        "--test",
        "scripts/verify-codex-guardian-controller.test.mjs",
        "scripts/verify-codex-host-guardian.test.mjs",
      ]
    : [
        "exec",
        "vitest",
        "run",
        "src/__tests__/lib/codex-session/guardian-application-service.integration.test.ts",
        "--no-file-parallelism",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
  { encoding: "utf8", timeout: 60000, maxBuffer: 1048576 },
);
writeFileSync(join(scratch, "runner.log"), `${run.stdout ?? ""}\n${run.stderr ?? ""}`, {
  mode: 0o600,
});
let passed = 0,
  failed = 1;
if (outer) {
  passed = Number(run.stdout?.match(/(?:#|ℹ) pass (\d+)/)?.[1] ?? 0);
  failed = Number(run.stdout?.match(/(?:#|ℹ) fail (\d+)/)?.[1] ?? 1);
} else {
  try {
    const r = JSON.parse(readFileSync(report));
    passed = r.numPassedTests;
    failed = r.numFailedTests;
  } catch {}
}
const sourceStable = paths.every((p) => hash(p) === sourceDigests[p]),
  endingBaseRevision = revision(),
  proof = {
    schemaVersion: 1,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    observedAt: new Date().toISOString(),
    mode: outer ? "outer-private-transport" : "signed-service",
    baseRevision,
    endingBaseRevision,
    sourceDigests,
    sourceStable,
    testedSourcesCommitted: !execFileSync("git", ["status", "--porcelain", "--", ...paths], {
      encoding: "utf8",
    }).trim(),
    passed:
      run.status === 0 &&
      passed === (outer ? 26 : 7) &&
      failed === 0 &&
      sourceStable &&
      endingBaseRevision === baseRevision,
    tests: { passed, failed },
    ...(database ? { database } : {}),
    checks: outer
      ? [
          "Three strict inherited-FD application methods require the admitted project and open lifetime.",
          "Independent controller/supervisor HMAC journals and original native spool must agree on closed input and complete terminal facts.",
          "Python receipt float/Unicode HMAC bytes and FD-pinned HEAD/index are independently verified before signing applied receipt.",
          "Unknown reserve/commit retains exact request/receipt; factual metadata and same-operation verify recover without re-reserving or timestamp rewrite.",
          "Changed native/barrier/lease across response, forged receipts/spool, active input and index/HEAD changes fail closed.",
        ]
      : [
          "Real Ed25519 signed fixed route crosses strict positive scoped-authority schema.",
          "Default-off, forged proof and foreign project/application/policy input reject.",
          "Observed PostgreSQL PgSleep proves signed authorization expiry and abort during UPDATE roll the transaction back.",
          "Wrong signed generation and concurrent persisted generation change cannot receive current-generation authority.",
        ],
    limitations: outer
      ? [
          "Application server responses and native terminal journals are explicitly synthetic unit fixtures; composed PostgreSQL/Python acceptance is a separate proof.",
          "FD3 fixture uses an actual local guardian subtree; no deployed host/native inference or remote attestation is claimed.",
        ]
      : [
          "Actual PostgreSQL/signing/transaction behavior uses fixture owner/package authority and synthetic completed native facts.",
          "A live request may mint a distinct <=30-second application grant bounded by runtime/registration; frame must remain live through commit.",
        ],
    inputBarrierIsKernelQuiescence: false,
    physicalWriterReleased: false,
    deployedActivation: false,
    cloudMutations: false,
    accountInference: false,
  };
const evidenceDirectory = resolve("docs/checks/autonomous-delivery/guardian-application-local"),
  output = resolve(
    process.env.HIVE_GUARDIAN_APPLICATION_ACTIONS_EVIDENCE_PATH ??
      join(evidenceDirectory, outer ? "outer-actions.json" : "signed-actions.json"),
  );
check(output.startsWith(`${evidenceDirectory}/`) && output.endsWith(".json"));
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "ignore" });
check(proof.passed);
process.stdout.write(
  `${JSON.stringify({ passed: true, tests: passed, sourceStable, evidence: output })}\n`,
);
