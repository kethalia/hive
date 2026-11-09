#!/usr/bin/env node
// Local bounded read boundary proof, never a deployment or account probe.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workspaceReadPackage } from "./build-workspace-read-package.mjs";

const check = (v) => {
  if (!v) throw new Error("workspace_read_proof_rejected");
};
const paths = [
  "templates/ai-dev-k8s/scripts/hive-workspace-read.mjs",
  "templates/ai-dev-k8s/scripts/hive-workspace-read.py",
  ...["read-contracts.ts", "read-client.server.ts", "read-service.server.ts"].map(
    (p) => `src/lib/workspaces/${p}`,
  ),
  "src/lib/codex-session/bootstrap-delivery.server.ts",
  "src/lib/codex-session/registration.server.ts",
  "src/lib/security/workspace-app-isolation.ts",
  "src/lib/coder/user-client.ts",
  "src/lib/coder/client.ts",
  "src/lib/coder/fetch.ts",
  "src/lib/git/clone-actions-contract.ts",
  "scripts/verify-workspace-read.test.mjs",
  "scripts/agents/test_workspace_read.py",
  ...[
    "read-client.test.ts",
    "read-service.test.ts",
    "read-transport.test.ts",
    "read-fixture.ts",
  ].map((p) => `src/__tests__/lib/workspaces/${p}`),
  "src/__tests__/lib/codex-session/bootstrap-delivery.test.ts",
  "scripts/build-workspace-read-package.mjs",
  "scripts/probe-workspace-read.mjs",
];
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex"),
  sourceDigests = Object.fromEntries(paths.map((p) => [p, hash(p)])),
  revision = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baseRevision = revision(),
  scratch = mkdtempSync(join(tmpdir(), "hive-workspace-read-proof-")),
  report = join(scratch, "vitest.json");
const runs = [
  [process.execPath, ["--test", "scripts/verify-workspace-read.test.mjs"]],
  ["/usr/bin/python3", ["-B", "scripts/agents/test_workspace_read.py"]],
  [
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "src/__tests__/lib/workspaces/read-client.test.ts",
      "src/__tests__/lib/workspaces/read-service.test.ts",
      "src/__tests__/lib/workspaces/read-transport.test.ts",
      "src/__tests__/lib/codex-session/bootstrap-delivery.test.ts",
      "--no-file-parallelism",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
  ],
].map(([cmd, args], i) => {
  const run = spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, maxBuffer: 1048576 });
  writeFileSync(join(scratch, `runner-${i}.log`), `${run.stdout ?? ""}\n${run.stderr ?? ""}`, {
    mode: 0o600,
  });
  return run;
});
let ts = { numPassedTests: 0, numFailedTests: 1 };
try {
  ts = JSON.parse(readFileSync(report));
} catch {}
const node = Number(runs[0].stdout?.match(/(?:#|ℹ) pass (\d+)/)?.[1] ?? 0),
  python = Number(runs[1].stderr?.match(/Ran (\d+) tests/)?.[1] ?? 0),
  artifact = await workspaceReadPackage(process.cwd()),
  sourceStable = paths.every((p) => hash(p) === sourceDigests[p]),
  endingBaseRevision = revision(),
  proof = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    baseRevision,
    endingBaseRevision,
    sourceStable,
    sourceDigests,
    testedSourcesCommitted: !execFileSync("git", ["status", "--porcelain", "--", ...paths], {
      encoding: "utf8",
    }).trim(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    tests: {
      nodePassed: node,
      pythonPassed: python,
      typeScriptPassed: ts.numPassedTests,
      typeScriptFailed: ts.numFailedTests,
    },
    package: {
      compressedBytes: artifact.compressed.length,
      expandedBytes: artifact.archive.length,
      archiveSha256: artifact.archiveSha256,
      manifestSha256: artifact.manifestSha256,
    },
    passed:
      runs.every((r) => r.status === 0) &&
      node === 7 &&
      python === 9 &&
      ts.numPassedTests === 25 &&
      ts.numFailedTests === 0 &&
      sourceStable,
    checks: [
      "Actual private tmux socket reads do not mutate sessions or touch the primary socket.",
      "Signed identity/config/manifest/lifetime, nonce replay and exact profile capability limits are enforced.",
      "Actual local HTTP service and canonical scoped app-cookie exchange code forward no owner credentials.",
      "Fresh Coder owner/build/app checks reject foreign, changed and ambiguous targets.",
      "Paths preserve CWD/fallback/home behavior with explicit outside-root/unavailable statuses and no contents.",
      "Pagination, command/output/stream deadlines and cancellation are bounded; no arbitrary exec/SSH interface exists.",
    ],
    limitations: [
      "Coder metadata and app-auth responses are synthetic fixtures, not live Coder calls.",
      "Profile configurations are exercised locally; no all-profile installation or browser parity is claimed.",
      "Installer, template/app activation and existing action dispatch are separate gates.",
    ],
    existingActionDispatchChanged: false,
    cloudMutations: false,
    newWorkspaces: false,
    accountInference: false,
  };
const directory = resolve("docs/checks/autonomous-delivery/workspace-read-local"),
  output = resolve(process.env.HIVE_WORKSPACE_READ_EVIDENCE_PATH ?? join(directory, "result.json"));
check(output.startsWith(`${directory}/`) && output.endsWith(".json"));
mkdirSync(directory, { recursive: true });
writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "ignore" });
check(proof.passed);
process.stdout.write(
  `${JSON.stringify({ passed: true, tests: proof.tests, sourceStable, evidence: output })}\n`,
);
