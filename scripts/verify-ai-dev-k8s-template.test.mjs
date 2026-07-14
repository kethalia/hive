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
  const gitCalls = join(fixtureRoot, "git-calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(manifest, "example/one|example/one\nexample/two|nested/two\n");

  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
set -eu
[ "$1 $2" = "repo clone" ]
[ "\${FAIL_REPOSITORY:-}" != "$3" ] || exit 1
mkdir -p "$4/.git"
printf '%s\\n' "$3|$4" >> "$GH_CALLS"
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$GIT_CALLS"
case "$*" in
  *"remote get-url origin") printf '%s\\n' "\${GIT_ORIGIN:-https://github.com/example/vault.git}" ;;
  *"symbolic-ref --quiet --short HEAD") printf '%s\\n' "main" ;;
  *"pull --ff-only origin main") [ "\${GIT_PULL_FAIL:-}" != "1" ] ;;
esac
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(join(home, "sync-vault.sh"), '#!/bin/sh\ntouch "$HOME/.vault-synced"\n');
  chmodSync(join(home, "sync-vault.sh"), 0o755);

  return { bin, calls, gitCalls, home, manifest };
}

function installFakeCoder(bin) {
  writeFileSync(
    join(bin, "coder"),
    `#!/bin/sh
set -eu
[ "$1 $2 $3" = "external-auth access-token github" ]
if [ "\${CODER_AUTH_FAIL:-}" = "1" ]; then
  printf 'https://coder.example.test/external-auth/github\n'
  exit 1
fi
printf 'fresh-test-token\\n'
`,
  );
  chmodSync(join(bin, "coder"), 0o755);
}

function verifyPodSecurity() {
  const terraform = readTemplateFile("main.tf");

  assert.match(terraform, /startup_script_behavior\s*=\s*"blocking"/);
  assert.match(terraform, /resource "coder_agent" "main"[\s\S]*?arch\s*=\s*"amd64"/);
  assert.match(terraform, /init_container \{/);
  assert.match(terraform, /name\s*=\s*"seed-home"/);
  assert.match(terraform, /cp -R --no-preserve=ownership,timestamps \/home\/coder\/\. \/target\//);
  assert.doesNotMatch(terraform, /cp -a \/home\/coder\/\. \/target\//);
  assert.match(terraform, /allow_privilege_escalation\s*=\s*false/);
  assert.doesNotMatch(terraform, /allow_privilege_escalation\s*=\s*true/);
  assert.match(terraform, /automount_service_account_token\s*=\s*false/);
  assert.match(terraform, /hostname\s*=\s*data\.coder_workspace\.me\.name/);
  assert.match(terraform, /fs_group_change_policy\s*=\s*"OnRootMismatch"/);
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
    "scripts/tools-filebrowser.sh",
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
  assert.match(
    terraform,
    /validation \{[\s\S]*?regex\s*=\s*"\^\$\|\^\(chillwhales\|kethalia\|phlox-labs\)/,
  );
  assert.doesNotMatch(terraform, /git-clone-vault|github-upload-public-key/);
  assert.doesNotMatch(initScript, /docker (info|version)/);
}

function verifyNonRootSupplementalTools() {
  const terraform = readTemplateFile("main.tf");
  const filebrowser = readTemplateFile("scripts/tools-filebrowser.sh");
  const initScript = readTemplateFile("scripts/init.sh");

  assert.ok(!terraform.includes('module "filebrowser"'));
  assert.ok(!terraform.includes('module "nodejs"'));
  assert.match(terraform, /resource "coder_script" "filebrowser"/);
  assert.match(terraform, /resource "coder_app" "filebrowser"/);
  assert.match(terraform, /start_blocks_login\s*=\s*false/);
  assert.match(terraform, /name\s*=\s*"vault_repo"[\s\S]*?mutable\s*=\s*false/);
  assert.ok(filebrowser.includes('filebrowser_version="2.63.18"'));
  assert.ok(
    filebrowser.includes("cd599c34afad0e8e61c577d1061c820bccb7feaa3c5a4477a12db586a1cd93ff"),
  );
  assert.ok(
    filebrowser.includes("29b3935c222d91522874e98dfa33195ee7d2acdac5dfbf37c1361a73704a28de"),
  );
  assert.ok(filebrowser.includes("$HOME/.local/bin/filebrowser"));
  assert.doesNotMatch(filebrowser, /\bsudo\b/);
  assert.ok(initScript.includes("- **Node.js**: v24"));
  assert.ok(!initScript.includes("also available: 18, 20, 22"));
}

function verifyAiAgentSelection() {
  const script = readTemplateFile("scripts/tools-ai.sh");
  const terraform = readTemplateFile("main.tf");
  const initScript = readTemplateFile("scripts/init.sh");
  const syncScript = readTemplateFile("scripts/sync-vault.sh");

  assert.ok(script.includes('npm_global_has "@openai/codex" && command_exists codex'));
  assert.ok(terraform.includes('module "claude-code"'));
  assert.ok(!terraform.includes('resource "coder_app" "gsd"'));

  for (const content of [script, terraform, initScript]) {
    assert.ok(!content.toLowerCase().includes("opengsd"));
    assert.ok(!content.toLowerCase().includes("gsd-pi"));
    assert.ok(!content.toLowerCase().includes("get-shit-done"));
  }
  assert.ok(!syncScript.includes("$HOME/.pi"));
  assert.ok(syncScript.includes("[Pp][Ii]-*"));
  assert.ok(syncScript.includes("*[Gg][Ss][Dd]*) return 1"));
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
  delete env.GH_TOKEN;
  const credential = join(TEMPLATE_ROOT, "scripts/github-credential.sh");
  const credentialResult = spawnSync("/bin/sh", [credential, "get"], {
    encoding: "utf8",
    env,
    input: "protocol=https\nhost=github.com\n\n",
  });
  assert.equal(credentialResult.status, 0, credentialResult.stderr);
  assert.match(credentialResult.stdout, /password=fresh-test-token/);

  const providedTokenResult = spawnSync("/bin/sh", [credential, "get"], {
    encoding: "utf8",
    env: { ...env, GH_TOKEN: "provided-test-token", PATH: "/nonexistent" },
    input: "protocol=https\nhost=github.com\n\n",
  });
  assert.equal(providedTokenResult.status, 0, providedTokenResult.stderr);
  assert.match(providedTokenResult.stdout, /password=provided-test-token/);

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
  const allowedOwners = new Set(["chillwhales", "kethalia", "phlox-labs"]);

  assert.ok(entries.length > 0);
  for (const entry of entries) {
    const [repository, destination] = entry.split("|");
    const [sourceOwner] = repository.split("/");
    const [destinationOwner] = destination.split("/");
    assert.ok(
      allowedOwners.has(sourceOwner),
      `${repository} must belong to an approved organization`,
    );
    assert.ok(
      allowedOwners.has(destinationOwner),
      `${destination} must use an approved destination organization`,
    );
  }
  assert.ok(entries.includes("kethalia/k8s-cluster|kethalia/k8s-cluster"));
  assert.ok(entries.includes("phlox-labs/service-routing-api|phlox-labs/service-routing-api"));
}

function verifyRepositoryBootstrap() {
  const { bin, calls, gitCalls, home, manifest } = createBootstrapFixture();
  mkdirSync(join(home, "vault", ".obsidian"), { recursive: true });
  writeFileSync(join(home, "vault", ".obsidian", "workspace.json"), "metadata\n");
  mkdirSync(join(home, ".config", "hive"), { recursive: true });
  writeFileSync(join(home, ".config", "hive", "vault-repository"), "example/vault\n");

  const env = {
    ...process.env,
    GH_CALLS: calls,
    GIT_CALLS: gitCalls,
    GH_TOKEN: "test-token",
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    REPOSITORIES_FILE: manifest,
  };
  const script = join(TEMPLATE_ROOT, "scripts/clone-repositories.sh");

  const first = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...env, FAIL_REPOSITORY: "example/two" },
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /completed with 1 failure/);
  assert.equal(
    readFileSync(join(home, "vault", ".obsidian", "workspace.json"), "utf8"),
    "metadata\n",
  );
  writeFileSync(join(home, "vault", "local-note.md"), "uncommitted\n");

  const second = spawnSync("bash", [script], { encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(home, "vault", "local-note.md"), "utf8"), "uncommitted\n");
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 3);
  assert.match(second.stdout, /fast-forwarded vault checkout/);
  assert.match(readFileSync(gitCalls, "utf8"), /pull --ff-only origin main/);

  const divergentVault = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...env, GIT_PULL_FAIL: "1" },
  });
  assert.equal(divergentVault.status, 0, divergentVault.stderr);
  assert.match(divergentVault.stderr, /vault checkout is dirty or diverged/);
  assert.equal(readFileSync(join(home, "vault", "local-note.md"), "utf8"), "uncommitted\n");

  const mismatchedOrigin = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...env, GIT_ORIGIN: "git@github.com:example/different-vault.git" },
  });
  assert.equal(mismatchedOrigin.status, 0, mismatchedOrigin.stderr);
  assert.match(mismatchedOrigin.stderr, /vault origin does not match configured repository/);
}

function verifyFailedExternalAuth() {
  const { bin, home, manifest } = createBootstrapFixture();
  installFakeCoder(bin);
  const env = {
    ...process.env,
    CODER_AUTH_FAIL: "1",
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    REPOSITORIES_FILE: manifest,
  };
  delete env.GH_TOKEN;

  const script = join(TEMPLATE_ROOT, "scripts/clone-repositories.sh");
  const result = spawnSync("bash", [script], { encoding: "utf8", env });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /external-auth token is unavailable/);
  assert.doesNotMatch(result.stdout, /coder\.example\.test/);
}

test("Kubernetes workspace remains non-root and seeds image home into the PVC", verifyPodSecurity);
test(
  "file-loaded startup scripts do not contain Terraform dollar escaping or sudo",
  verifyFileLoadedScripts,
);
test("CI tooling installs without root and uses verified GitHub CLI artifacts", verifyCiTooling);
test("workspace bootstrap does not delete vault content or require Docker", verifySafeBootstrap);
test("supplemental tools support the non-root workspace", verifyNonRootSupplementalTools);
test("workspace only provisions Claude and Codex AI agents", verifyAiAgentSelection);
test("shell setup retries incomplete Oh My Zsh installations", verifyShellRetry);
test("GitHub helpers retrieve fresh Coder credentials on demand", verifyGithubHelpers);
test("repository manifest only includes approved organizations", verifyRepositoryManifest);
test(
  "repository bootstrap is idempotent and preserves local vault content",
  verifyRepositoryBootstrap,
);
test("repository bootstrap rejects failed external authentication", verifyFailedExternalAuth);
