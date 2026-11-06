import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { processIdentity } from "../templates/ai-dev-k8s/scripts/codex-process-identity.mjs";
import { validateHostConfig } from "../templates/ai-dev-k8s/scripts/codex-workspace-host.mjs";
import { buildNativeGuardian } from "./build-native-guardian.mjs";

test("optional guardian bundle copies the verified build artifact without compiling at install", () => {
  const directory = mkdtempSync(join(tmpdir(), "hive-guardian-package-"));
  try {
    const artifact = join(directory, "artifact");
    const guardian = buildNativeGuardian(process.cwd(), artifact);
    const output = join(directory, "package");
    execFileSync(process.execPath, ["scripts/build-codex-host-bundle.mjs", output], {
      env: { ...process.env, HIVE_GUARDIAN_ARTIFACT_DIR: artifact },
      stdio: "pipe",
    });
    const manifest = JSON.parse(readFileSync(join(output, "package-manifest.json")));
    assert.deepEqual(manifest.guardian, guardian);
    assert.equal(manifest.files["codex-native-guardian"], guardian.elfSha256);
    assert.deepEqual(
      readFileSync(join(output, "codex-native-guardian")),
      readFileSync(join(artifact, "codex-native-guardian")),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bundles only locked ws locally and keeps modules inert on import", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-host-package-")),
    out = join(dir, "package");
  try {
    execFileSync(process.execPath, ["scripts/build-codex-host-bundle.mjs", out], { stdio: "pipe" });
    const manifest = JSON.parse(readFileSync(join(out, "package-manifest.json")));
    assert.equal(manifest.wsVersion, "8.21.3");
    assert.equal(manifest.nativeVersion, "0.165.0");
    assert.equal(manifest.files["codex-native-guardian"], manifest.guardian.elfSha256);
    assert.ok(Object.hasOwn(manifest.files, "github-evidence.py"));
    assert.ok(Object.hasOwn(manifest.files, "delivery-source-runtime.py"));
    assert.ok(Object.hasOwn(manifest.files, "delivery-source-worker.py"));
    for (const name of [
      "codex-source-application.mjs",
      "codex-delivery-runtime.mjs",
      "codex-acceptance-native.mjs",
      "codex-acceptance-pump.mjs",
      "codex-acceptance-runtime.mjs",
      "delivery-acceptance-client.mjs",
      "delivery-acceptance-material.mjs",
      "delivery-acceptance-material.py",
      "delivery-source-apply-client.mjs",
      "delivery-source-apply-worker.py",
    ])
      assert.ok(Object.hasOwn(manifest.files, name));
    assert.ok(Object.hasOwn(manifest.files, "delivery-source-broker.py"));
    assert.ok(Object.hasOwn(manifest.files, "delivery-source-provider.py"));
    assert.ok(Object.hasOwn(manifest.files, "codex-native-namespace.mjs"));
    for (const [name, sha] of Object.entries(manifest.files))
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(out, name)))
          .digest("hex"),
        sha,
      );
    const entry = join(out, "codex-workspace-host.mjs");
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m=await import(${JSON.stringify(entry)});process.stdout.write(typeof m.startWorkspaceHost)`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(output, "function");
    const collector = join(out, "delivery-github-collector.mjs");
    assert.equal(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const m=await import(${JSON.stringify(collector)});process.stdout.write(typeof m.createDeliveryGitHubCollector)`,
        ],
        { encoding: "utf8" },
      ),
      "function",
    );
    assert.equal(readdirSync(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("host config cannot request unreviewed startup fields or profiles", () => {
  const config = {
    schemaVersion: 1,
    enabled: true,
    profile: "software",
    binding: {},
    hiveOrigin: "https://hive.example.com",
    issuerPublicKeyPem: "public",
    issuerKeyId: "issuer",
    port: 13341,
    model: "gpt-6.1-sol",
    effort: "low",
    managerEnabled: false,
  };
  assert.deepEqual(validateHostConfig(config), config);
  for (const patch of [
    { enabled: false },
    { profile: "browser" },
    { codexExecutable: "/arbitrary" },
    { port: 22 },
    { command: "bad" },
    { managerEnabled: true },
    { nativeIsolationEnabled: "true" },
  ])
    assert.throws(() => validateHostConfig({ ...config, ...patch }));
  assert.equal(
    validateHostConfig({ ...config, nativeIsolationEnabled: true }).nativeIsolationEnabled,
    true,
  );
  assert.equal(
    validateHostConfig({ ...config, nativeIsolationEnabled: true, managerEnabled: true })
      .managerEnabled,
    true,
  );
});

test("JS controller and installed Python authority agree on actual kernel process identity", () => {
  const path = resolve("templates/ai-dev-k8s/scripts/codex-project-lease.py");
  const script = `import importlib.util,json,os
s=importlib.util.spec_from_file_location('lease',${JSON.stringify(path)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.process_identity(os.getppid())))
`;
  const value = JSON.parse(
    execFileSync("/usr/bin/python3", ["-B", "-c", script], { encoding: "utf8" }),
  );
  assert.deepEqual(value, processIdentity(process.pid));
});
