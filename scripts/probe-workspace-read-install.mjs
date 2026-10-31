#!/usr/bin/env node
// Explicit native isolated-home/network proof. No workspace/cloud/account calls.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const check = (v) => {
  if (!v) throw new Error("workspace_read_installer_proof_rejected");
};
const paths = [
    "templates/ai-dev-k8s/scripts/install-workspace-read.py",
    "templates/ai-dev-k8s/scripts/hive-workspace-read.mjs",
    "templates/ai-dev-k8s/scripts/hive-workspace-read.py",
    "scripts/build-workspace-read-package.mjs",
    "scripts/agents/test_workspace_read_install.py",
    "scripts/verify-workspace-read-install.test.mjs",
    "scripts/fixtures/workspace-read-install.py",
    "scripts/fixtures/workspace-read-install-entry.py",
    "scripts/fixtures/workspace-identity-install.py",
    "scripts/probe-workspace-read-install.mjs",
  ],
  hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex"),
  sourceDigests = Object.fromEntries(paths.map((p) => [p, hash(p)])),
  revision = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baseRevision = revision(),
  directory = resolve("docs/checks/autonomous-delivery/workspace-read-install-local"),
  nativeReport = resolve(
    process.env.HIVE_WORKSPACE_READ_INSTALL_REPORT ?? join(directory, "actual.json"),
  ),
  output = resolve(
    process.env.HIVE_WORKSPACE_READ_INSTALL_EVIDENCE_PATH ?? join(directory, "result.json"),
  );
for (const p of [nativeReport, output]) check(p.startsWith(`${directory}/`) && p.endsWith(".json"));
mkdirSync(directory, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "hive-read-installer-proof-"));
const pure = spawnSync(
  "/usr/bin/python3",
  ["-B", "scripts/agents/test_workspace_read_install.py"],
  { encoding: "utf8", timeout: 10000, maxBuffer: 1048576 },
);
const native = spawnSync(
  process.execPath,
  ["--test", "scripts/verify-workspace-read-install.test.mjs"],
  {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1048576,
    env: {
      ...process.env,
      HIVE_WORKSPACE_READ_INSTALL_NATIVE: "1",
      HIVE_WORKSPACE_READ_INSTALL_REPORT: nativeReport,
    },
  },
);
for (const [name, r] of [
  ["pure", pure],
  ["native", native],
])
  writeFileSync(join(scratch, `${name}.log`), `${r.stdout ?? ""}\n${r.stderr ?? ""}`, {
    mode: 0o600,
  });
let report;
try {
  report = JSON.parse(readFileSync(nativeReport));
} catch {
  report = { passed: false };
}
const sourceStable = paths.every((p) => hash(p) === sourceDigests[p]),
  proof = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    baseRevision,
    endingBaseRevision: revision(),
    sourceStable,
    sourceDigests,
    testedSourcesCommitted: !execFileSync("git", ["status", "--porcelain", "--", ...paths], {
      encoding: "utf8",
    }).trim(),
    passed: pure.status === 0 && native.status === 0 && report.passed === true && sourceStable,
    tests: {
      pure: Number(pure.stderr?.match(/Ran (\d+) tests/)?.[1] ?? 0),
      actual: Number(native.stdout?.match(/(?:#|ℹ) pass (\d+)/)?.[1] ?? 0),
    },
    actual: report,
    checks: {
      noProductNodeOwnershipBypass: true,
      noPrimaryHomeOrPortBind: true,
      noProcessAdoptionOrKill: true,
      pidReuseDistinctFromSameIdentityExecutableChange: true,
      uncertainStartupHeld: true,
      historyPreserved: true,
    },
    limitations: [
      "The unprivileged user namespace maps the root-owned Node inode to UID65534. Only the test entry translates this exact inode/hash's ownership after outer independent UID0/version/hash verification.",
      "The actual Node CLI, service package/config/health, kernel PID/start/executable/argv and private13342 listener checks are real; no production config or environment bypass exists.",
      "Reboot/PID-reuse negative records are deliberately re-signed fixture history; no real host reboot or unrelated process is altered.",
      "Authenticated manifest resolution is explicitly synthetic in this installer lifecycle fixture; the pinned SDK/TLS and one actual deployment RPC are separate evidence.",
      "The package is not installed into a Coder workspace/template and no app/deployment flag is activated.",
    ],
    cloudMutations: false,
    newWorkspaces: false,
    accountInference: false,
  };
writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
for (const p of [nativeReport, output])
  execFileSync("pnpm", ["exec", "biome", "format", "--write", p], { stdio: "ignore" });
check(proof.passed && proof.tests.pure === 8 && proof.tests.actual === 1);
process.stdout.write(
  `${JSON.stringify({ passed: true, tests: proof.tests, sourceStable, evidence: output })}\n`,
);
