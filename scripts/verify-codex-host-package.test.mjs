import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateHostConfig } from "../templates/ai-dev-k8s/scripts/codex-workspace-host.mjs";
test("bundles only locked ws locally and keeps modules inert on import", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-host-package-")),
    out = join(dir, "package");
  try {
    execFileSync(process.execPath, ["scripts/build-codex-host-bundle.mjs", out], { stdio: "pipe" });
    const manifest = JSON.parse(readFileSync(join(out, "package-manifest.json")));
    assert.equal(manifest.wsVersion, "8.21.3");
    assert.equal(manifest.nativeVersion, "0.165.0");
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
  ])
    assert.throws(() => validateHostConfig({ ...config, ...patch }));
});
