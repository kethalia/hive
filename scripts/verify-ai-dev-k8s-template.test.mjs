/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are created under an isolated mkdtemp fixture. */
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

function createBootstrapFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ai-dev-k8s-bootstrap-"));
  const home = join(fixtureRoot, "home");
  const bin = join(fixtureRoot, "bin");
  const manifest = join(fixtureRoot, "repositories.txt");
  const calls = join(fixtureRoot, "gh-calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(manifest, "example/one|example/one\nexample/two|nested/two\n");

  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
set -eu
[ "$1 $2" = "repo clone" ]
mkdir -p "$4/.git"
printf '%s\\n' "$3|$4" >> "$GH_CALLS"
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(join(home, "sync-vault.sh"), '#!/bin/sh\ntouch "$HOME/.vault-synced"\n');
  chmodSync(join(home, "sync-vault.sh"), 0o755);

  return { bin, calls, home, manifest };
}

function installFakeCoder(bin) {
  writeFileSync(
    join(bin, "coder"),
    `#!/bin/sh
set -eu
[ "$1 $2 $3" = "external-auth access-token github" ]
printf 'fresh-test-token\\n'
`,
  );
  chmodSync(join(bin, "coder"), 0o755);
}

function verifyPodSecurity() {
  const terraform = readTemplateFile("main.tf");

  assert.match(terraform, /startup_script_behavior\s*=\s*"blocking"/);
  assert.match(terraform, /init_container \{/);
  assert.match(terraform, /name\s*=\s*"seed-home"/);
  assert.match(terraform, /cp -a \/home\/coder\/\. \/target\//);
  assert.match(terraform, /allow_privilege_escalation\s*=\s*false/);
  assert.doesNotMatch(terraform, /allow_privilege_escalation\s*=\s*true/);
  assert.match(terraform, /"app\.kubernetes\.io\/name"\s*=\s*"coder-workspace"/);
  assert.doesNotMatch(terraform, /ignore_changes\s*=\s*all/);
  assert.match(terraform, /name\s*=\s*"home_disk_size"[\s\S]*?mutable\s*=\s*false/);
  assert.match(terraform, /name\s*=\s*"USER"[\s\S]*?value\s*=\s*"coder"/);
  assert.match(terraform, /name\s*=\s*"HOME"[\s\S]*?value\s*=\s*"\/home\/coder"/);
}

function verifyFileLoadedScripts() {
  for (const relativePath of [
    "scripts/init.sh",
    "scripts/github-cli.sh",
    "scripts/github-credential.sh",
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
}

function verifyCiTooling() {
  const script = readTemplateFile("scripts/tools-ci.sh");

  assert.doesNotMatch(script, /\bsudo\b/);
  assert.match(script, /GH_VERSION=2\.96\.0/);
  assert.match(script, /83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60/);
  assert.match(script, /sha256sum --check --status/);
  assert.match(script, /credential\.https:\/\/github\.com\.helper/);
  assert.match(script, /\.local\/libexec\/gh/);
}

function verifySafeBootstrap() {
  const cloneScript = readTemplateFile("scripts/clone-repositories.sh");
  const initScript = readTemplateFile("scripts/init.sh");
  const terraform = readTemplateFile("main.tf");

  assert.doesNotMatch(cloneScript, /rsync\s+.*--delete/);
  assert.doesNotMatch(cloneScript, /gh auth setup-git/);
  assert.match(cloneScript, /! -name \.obsidian/);
  assert.doesNotMatch(terraform, /git-clone-vault|github-upload-public-key/);
  assert.doesNotMatch(initScript, /docker (info|version)/);
}

function verifyAiToolRefresh() {
  const script = readTemplateFile("scripts/tools-ai.sh");

  assert.ok(!script.includes('rm -f "$HOME/.local/bin/gsd"'));
  assert.ok(!script.includes('rm -f "$HOME/.local/bin/codex"'));
  assert.ok(script.includes('npm_global_has "@openai/codex" && command_exists codex'));
  assert.ok(script.includes('npm_global_has "@opengsd/gsd-pi" && command_exists gsd'));
  assert.ok(script.includes("if command_exists get-shit-done-redux; then"));
  assert.ok(script.includes('run_step "OpenGSD command surfaces"'));
}

function verifyShellRetry() {
  const script = readTemplateFile("scripts/tools-shell.sh");

  assert.match(script, /"\$HOME\/\.oh-my-zsh\/\.hive-install-complete"/);
  assert.match(script, /touch "\$HOME\/\.oh-my-zsh\/\.hive-install-complete"/);
  assert.doesNotMatch(script, /install_if_missing "Oh My Zsh" "" "\$HOME\/\.oh-my-zsh"/);
}

function verifyGithubHelpers() {
  const { bin, home } = createBootstrapFixture();
  installFakeCoder(bin);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const credential = join(TEMPLATE_ROOT, "scripts/github-credential.sh");
  const credentialResult = spawnSync("sh", [credential, "get"], {
    encoding: "utf8",
    env,
    input: "protocol=https\nhost=github.com\n\n",
  });
  assert.equal(credentialResult.status, 0, credentialResult.stderr);
  assert.match(credentialResult.stdout, /password=fresh-test-token/);

  const realGh = join(bin, "gh-real");
  writeFileSync(realGh, '#!/bin/sh\nprintf "%s|%s\\n" "$GH_TOKEN" "$*"\n');
  chmodSync(realGh, 0o755);
  const cli = join(TEMPLATE_ROOT, "scripts/github-cli.sh");
  const cliResult = spawnSync("sh", [cli, "repo", "view"], {
    encoding: "utf8",
    env: { ...env, GH_REAL_BIN: realGh },
  });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(cliResult.stdout.trim(), "fresh-test-token|repo view");
}

function verifyRepositoryManifest() {
  const entries = readTemplateFile("repositories.txt").trim().split("\n");

  assert.equal(entries.length, 25);
  assert.ok(entries.includes("kethalia/pearl-mining-web|cansitki/pearl-mining-web"));
  assert.ok(entries.includes("kethalia/k8s-cluster|kethalia/k8s-cluster"));
  assert.ok(entries.includes("phlox-labs/service-routing-api|phlox-labs/service-routing-api"));
}

function verifyRepositoryBootstrap() {
  const { bin, calls, home, manifest } = createBootstrapFixture();
  mkdirSync(join(home, "vault", ".obsidian"), { recursive: true });
  writeFileSync(join(home, "vault", ".obsidian", "workspace.json"), "metadata\n");

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
  assert.equal(
    readFileSync(join(home, "vault", ".obsidian", "workspace.json"), "utf8"),
    "metadata\n",
  );
  writeFileSync(join(home, "vault", "local-note.md"), "uncommitted\n");

  const second = spawnSync("bash", [script], { encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(home, "vault", "local-note.md"), "utf8"), "uncommitted\n");
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 3);
  assert.match(second.stdout, /preserving local changes/);
}

test("Kubernetes workspace remains non-root and seeds image home into the PVC", verifyPodSecurity);
test(
  "file-loaded startup scripts do not contain Terraform dollar escaping or sudo",
  verifyFileLoadedScripts,
);
test("CI tooling installs without root and uses verified GitHub CLI artifacts", verifyCiTooling);
test("workspace bootstrap does not delete vault content or require Docker", verifySafeBootstrap);
test("AI tool refresh preserves existing shims when installation fails", verifyAiToolRefresh);
test("shell setup retries incomplete Oh My Zsh installations", verifyShellRetry);
test("GitHub helpers retrieve fresh Coder credentials on demand", verifyGithubHelpers);
test("repository manifest preserves the requested 25-checkout layout", verifyRepositoryManifest);
test(
  "repository bootstrap is idempotent and preserves local vault content",
  verifyRepositoryBootstrap,
);
