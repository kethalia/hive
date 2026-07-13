import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const TEMPLATE_ROOT = join(process.cwd(), "templates/ai-dev-k8s");

function readTemplateFile(relativePath) {
  return readFileSync(join(TEMPLATE_ROOT, relativePath), "utf8");
}

test("Kubernetes workspace remains non-root and seeds image home into the PVC", () => {
  const terraform = readTemplateFile("main.tf");

  assert.match(terraform, /startup_script_behavior\s*=\s*"blocking"/);
  assert.match(terraform, /init_container \{/);
  assert.match(terraform, /name\s*=\s*"seed-home"/);
  assert.match(terraform, /cp -a \/home\/coder\/\. \/target\//);
  assert.match(terraform, /allow_privilege_escalation\s*=\s*false/);
  assert.doesNotMatch(terraform, /allow_privilege_escalation\s*=\s*true/);
  assert.match(terraform, /"app\.kubernetes\.io\/name"\s*=\s*"coder-workspace"/);
  assert.doesNotMatch(terraform, /ignore_changes\s*=\s*all/);
});

test("file-loaded startup scripts do not contain Terraform dollar escaping or sudo", () => {
  for (const relativePath of [
    "scripts/init.sh",
    "scripts/symlinks.sh",
    "scripts/tools-ai.sh",
    "scripts/tools-browser.sh",
    "scripts/tools-node.sh",
    "scripts/tools-shell.sh",
    "scripts/tools-web3.sh",
  ]) {
    const script = readTemplateFile(relativePath);
    assert.doesNotMatch(script, /\$\$\{/, `${relativePath} must use normal shell expansion`);
    assert.doesNotMatch(
      script,
      /\bsudo\b/,
      `${relativePath} must run without privilege escalation`,
    );
  }
});

test("CI tooling installs without root and uses verified GitHub CLI artifacts", () => {
  const script = readTemplateFile("scripts/tools-ci.sh");

  assert.doesNotMatch(script, /\bsudo\b/);
  assert.match(script, /GH_VERSION=2\.96\.0/);
  assert.match(script, /83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60/);
  assert.match(script, /sha256sum --check --status/);
});

test("workspace bootstrap does not delete vault content or require Docker", () => {
  const cloneScript = readTemplateFile("scripts/clone-repositories.sh");
  const initScript = readTemplateFile("scripts/init.sh");
  const terraform = readTemplateFile("main.tf");

  assert.doesNotMatch(cloneScript, /rsync\s+.*--delete/);
  assert.doesNotMatch(terraform, /git-clone-vault|github-upload-public-key/);
  assert.doesNotMatch(initScript, /docker (info|version)/);
});

test("repository manifest preserves the requested 25-checkout layout", () => {
  const entries = readTemplateFile("repositories.txt").trim().split("\n");

  assert.equal(entries.length, 25);
  assert.ok(entries.includes("kethalia/pearl-mining-web|cansitki/pearl-mining-web"));
  assert.ok(entries.includes("kethalia/k8s-cluster|kethalia/k8s-cluster"));
  assert.ok(entries.includes("phlox-labs/service-routing-api|phlox-labs/service-routing-api"));
});

test("repository bootstrap is idempotent and preserves local vault content", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ai-dev-k8s-bootstrap-"));
  const home = join(fixtureRoot, "home");
  const bin = join(fixtureRoot, "bin");
  const manifest = join(fixtureRoot, "repositories.txt");
  const calls = join(fixtureRoot, "gh-calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(manifest, "example/one|example/one\nexample/two|nested/two\n");

  const fakeGh = `#!/bin/sh
set -eu
[ "$1 $2" = "repo clone" ]
mkdir -p "$4/.git"
printf '%s\\n' "$3|$4" >> "$GH_CALLS"
`;
  writeFileSync(join(bin, "gh"), fakeGh);
  chmodSync(join(bin, "gh"), 0o755);

  const fakeGit = `#!/bin/sh
exit 0
`;
  writeFileSync(join(bin, "git"), fakeGit);
  chmodSync(join(bin, "git"), 0o755);

  const syncVault = `#!/bin/sh
touch "$HOME/.vault-synced"
`;
  writeFileSync(join(home, "sync-vault.sh"), syncVault);
  chmodSync(join(home, "sync-vault.sh"), 0o755);

  const env = {
    ...process.env,
    GH_CALLS: calls,
    GH_TOKEN: "test-token",
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    REPOSITORIES_FILE: manifest,
    VAULT_REPOSITORY: "example/vault",
  };
  const script = join(TEMPLATE_ROOT, "scripts/clone-repositories.sh");

  const first = spawnSync("bash", [script], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  writeFileSync(join(home, "vault", "local-note.md"), "uncommitted\n");

  const second = spawnSync("bash", [script], { encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(home, "vault", "local-note.md"), "utf8"), "uncommitted\n");
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 3);
  assert.match(second.stdout, /preserving local changes/);
});
