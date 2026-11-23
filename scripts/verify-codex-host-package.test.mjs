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
    for (const name of [
      "codex-project-repository.py",
      "github-projects.py",
      "codex-native-namespace.mjs",
      "codex-workspace-host-outer.mjs",
      "codex-workspace-host-worker.mjs",
      "delivery-manager-adapter.mjs",
      "delivery-native-spool.mjs",
    ])
      assert.ok(Object.hasOwn(manifest.files, name));
    for (const [name, sha] of Object.entries(manifest.files))
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(out, name)))
          .digest("hex"),
        sha,
      );
    const resolveRepository = `
import importlib.util, io, json, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("managed", sys.argv[1])
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)
repo = {
    "id": 12, "node_id": "repo_12", "full_name": "hive/sample",
    "name": "sample", "owner": {"login": "hive"}, "default_branch": "release/current",
    "private": False, "archived": False, "permissions": {"pull": True, "push": True},
    "clone_url": "https://github.com/hive/sample.git",
}
metadata = {
    "/user": {"id": 42},
    "/repositories/12": repo,
    "/repos/hive/sample/git/ref/heads/release/current": {
        "ref": "refs/heads/release/current", "object": {"type": "commit", "sha": "a" * 40},
    },
}
seen = []
class Reply(io.BytesIO):
    status = 200
    headers = {}
class Opener:
    def open(self, request, timeout):
        assert request.full_url.startswith("https://api.github.com/")
        assert request.get_header("Authorization") == "Bearer test-local-token"
        path = request.full_url.removeprefix("https://api.github.com")
        seen.append(path)
        return Reply(json.dumps(metadata[path]).encode())
with patch.object(managed, "workspace_token", return_value="test-local-token"):
    with patch.object(managed.urllib.request, "build_opener", return_value=Opener()):
        result = managed.resolve_repository({
            "schemaVersion": 1, "operation": "resolve", "repositoryId": "12", "expectedAccountId": "42",
        })
assert result["defaultRevision"] == "a" * 40
assert seen == list(metadata)
`;
    execFileSync(
      "/usr/bin/python3",
      ["-I", "-B", "-c", resolveRepository, join(out, "codex-project-repository.py")],
      { stdio: "pipe" },
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
    managerEnabled: true,
    guardianEnabled: true,
    nativeIsolationEnabled: true,
  };
  assert.deepEqual(validateHostConfig(config), config);
  for (const patch of [
    { enabled: false },
    { profile: "browser" },
    { codexExecutable: "/arbitrary" },
    { port: 22 },
    { command: "bad" },
    { managerEnabled: false },
    { guardianEnabled: false },
    { nativeIsolationEnabled: false },
    { deliveryExecutionEnabled: true },
    { nativeIsolationEnabled: "true" },
  ])
    assert.throws(() => validateHostConfig({ ...config, ...patch }));
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
