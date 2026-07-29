/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are created under an isolated mkdtemp fixture. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const TEMPLATE_ROOT = join(process.cwd(), "templates/ai-dev-k8s");
const DOCKER_TEMPLATE_ROOT = join(process.cwd(), "templates/ai-dev");

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
[ "\${FAIL_REPOSITORY:-}" != "$3" ] || exit 1
mkdir -p "$4/.git"
printf '%s\\n' "$3|$4" >> "$GH_CALLS"
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, calls, home, manifest };
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
  assert.match(
    terraform,
    /workspace_hostname_candidate\s*=\s*trim\(substr\(replace\(lower\(data\.coder_workspace\.me\.name\), "\/\[\^a-z0-9-\]\/", "-"\), 0, 63\), "-"\)/,
  );
  assert.match(
    terraform,
    /workspace_hostname\s*=\s*local\.workspace_hostname_candidate != "" \? local\.workspace_hostname_candidate : "workspace"/,
  );
  assert.match(terraform, /hostname\s*=\s*local\.workspace_hostname/);
  assert.match(
    terraform,
    /resource "kubernetes_deployment_v1" "workspace" \{[\s\S]*?name\s*=\s*"coder-\$\{data\.coder_workspace\.me\.id\}"/,
  );
  assert.match(
    terraform,
    /selector \{[\s\S]*?"app\.kubernetes\.io\/instance"\s*=\s*"coder-\$\{data\.coder_workspace\.me\.id\}"/,
  );
  assert.match(terraform, /fs_group_change_policy\s*=\s*"OnRootMismatch"/);
  assert.match(terraform, /"app\.kubernetes\.io\/name"\s*=\s*"coder-workspace"/);
  assert.doesNotMatch(terraform, /ignore_changes\s*=\s*all/);
  assert.doesNotMatch(terraform, /data "coder_parameter"/);
  assert.doesNotMatch(terraform, /variable "/);
  assert.doesNotMatch(terraform, /module "dotfiles"/);
  assert.match(terraform, /storage\s*=\s*"100Gi"/);
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
    const terraformShellExpansion = "$" + "$" + "{agent_file##*/}";
    const unsupportedEscapes = script.replaceAll(terraformShellExpansion, "");
    assert.doesNotMatch(
      unsupportedEscapes,
      /\$\$\{/,
      `${relativePath} must use normal shell expansion`,
    );
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
  assert.doesNotMatch(cloneScript, /vault|obsidian/i);
  assert.doesNotMatch(terraform, /vault_repo|git-clone-vault|mcpvault/);
  assert.doesNotMatch(terraform, /git-clone-vault|github-upload-public-key/);
  assert.doesNotMatch(initScript, /docker (info|version)/);
  assert.match(initScript, /servers\.pop\("obsidian", None\)/);
  assert.match(initScript, /managed_tables/);
  assert.doesNotMatch(initScript, /existing\.split\(start/);
  assert.match(initScript, /\.config\/autostart\/obsidian\.desktop/);
  assert.match(initScript, /remove_vault_managed_context/);
  assert.match(initScript, /\.vault-managed/);
  assert.doesNotMatch(initScript, /rm[^\n]*\$HOME\/vault/);

  for (const templateRoot of [
    TEMPLATE_ROOT,
    DOCKER_TEMPLATE_ROOT,
    join(process.cwd(), "templates/hive"),
  ]) {
    const templateInit = readFileSync(join(templateRoot, "scripts/init.sh"), "utf8");
    assert.match(templateInit, /remove_vault_managed_context/);
    assert.match(templateInit, /\.vault-managed/);
    assert.match(templateInit, /\$\$\{agent_file##\*\/\}/);
    assert.doesNotMatch(templateInit, /personal knowledge vault at `~\/vault`/);
    assert.doesNotMatch(templateInit, /rm[^\n]*\$HOME\/vault/);
  }

  for (const templateRoot of [DOCKER_TEMPLATE_ROOT, join(process.cwd(), "templates/hive")]) {
    const templateInit = readFileSync(join(templateRoot, "scripts/init.sh"), "utf8");
    assert.match(templateInit, /\$HOME\/\.pi\/agent\/skills/);
    assert.match(templateInit, /\$HOME\/\.pi\/agent\/AGENTS\.md/);
    assert.match(templateInit, /\$HOME\/\.pi\/agent\/CLAUDE\.md/);
  }
}

function seedVaultManagedContextFixture(home) {
  const managedSkill = join(home, ".agents", "skills", "managed-skill");
  const retainedSkill = join(home, ".agents", "skills", "retained-skill");
  const piManagedSkill = join(home, ".pi", "agent", "skills", "pi-managed-skill");
  const piRetainedSkill = join(home, ".pi", "agent", "skills", "pi-retained-skill");
  const vault = join(home, "vault");
  const vaultAgents = join(vault, "Agents");

  mkdirSync(managedSkill, { recursive: true });
  mkdirSync(retainedSkill, { recursive: true });
  mkdirSync(piManagedSkill, { recursive: true });
  mkdirSync(piRetainedSkill, { recursive: true });
  mkdirSync(vaultAgents, { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, "sync-vault.sh"), "# legacy vault integration\n");
  writeFileSync(join(managedSkill, "SKILL.md"), "managed\n");
  writeFileSync(join(retainedSkill, "SKILL.md"), "retained\n");
  writeFileSync(join(piManagedSkill, "SKILL.md"), "managed\n");
  writeFileSync(join(piRetainedSkill, "SKILL.md"), "retained\n");
  writeFileSync(join(home, ".agents", "skills", ".vault-managed"), "managed-skill\n../vault\n");
  writeFileSync(join(home, ".pi", "agent", "skills", ".vault-managed"), "pi-managed-skill\n");
  writeFileSync(join(vaultAgents, "AGENTS.md"), "# Custom vault agent context\n");
  writeFileSync(join(home, ".codex", "AGENTS.md"), "# Custom vault agent context\n");
  writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), "# Custom vault agent context\n");
  writeFileSync(join(home, ".agents", "CLAUDE.md"), "# User-owned Claude context\n");
  writeFileSync(join(vault, "keep.txt"), "keep\n");
  return { managedSkill, piManagedSkill, piRetainedSkill, retainedSkill, vault };
}

function runVaultManagedContextCleanupFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ai-dev-vault-cleanup-"));
  const home = join(fixtureRoot, "home");
  const paths = seedVaultManagedContextFixture(home);
  const initScript = readFileSync(join(DOCKER_TEMPLATE_ROOT, "scripts/init.sh"), "utf8");
  const functionMatch = initScript.match(
    /remove_vault_managed_context\(\) \{[\s\S]*?\n\}\n\nremove_vault_managed_context/,
  );

  assert.ok(functionMatch);
  const claudeTemplateToken = "$" + "{claude_md_content}";
  const renderedFunction = functionMatch[0]
    .replace(/\n\nremove_vault_managed_context$/, "")
    .replace(claudeTemplateToken, "# Coder Workspace")
    .replaceAll("$" + "$" + "{", "$" + "{");
  const cleanup = [renderedFunction, "remove_vault_managed_context", ""].join("\n");
  const script = join(fixtureRoot, "cleanup.sh");
  writeFileSync(script, cleanup);
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });

  return {
    home,
    ...paths,
    result,
  };
}

function verifyVaultManagedContextCleanup() {
  const { home, managedSkill, piManagedSkill, piRetainedSkill, retainedSkill, result, vault } =
    runVaultManagedContextCleanupFixture();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(managedSkill), false);
  assert.equal(existsSync(retainedSkill), true);
  assert.equal(existsSync(piManagedSkill), false);
  assert.equal(existsSync(piRetainedSkill), true);
  assert.equal(existsSync(join(home, ".agents", "skills", ".vault-managed")), false);
  assert.equal(existsSync(join(home, ".pi", "agent", "skills", ".vault-managed")), false);
  assert.equal(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8"), "# Coder Workspace\n");
  assert.equal(
    readFileSync(join(home, ".pi", "agent", "AGENTS.md"), "utf8"),
    "# Coder Workspace\n",
  );
  assert.equal(
    readFileSync(join(home, ".agents", "CLAUDE.md"), "utf8"),
    "# User-owned Claude context\n",
  );
  assert.equal(readFileSync(join(vault, "keep.txt"), "utf8"), "keep\n");
}

function verifyBaseImageRollout() {
  const workflow = readFileSync(
    join(process.cwd(), ".github/workflows/build-base-image.yml"),
    "utf8",
  );

  assert.match(workflow, /Smoke test — Unity Hub present/);
  assert.match(workflow, /Smoke test — Blender starts/);
  assert.match(workflow, /Smoke test — Obsidian retained/);
  assert.match(workflow, /docker buildx imagetools inspect/);
  assert.match(workflow, /chore\(template\): update hive-base image digest/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /gh pr list --head "\$branch" --state all/);
  assert.match(workflow, /gh pr reopen/);
  assert.match(workflow, /gh workflow run ci\.yml --ref "\$branch"/);
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
  assert.match(
    workflow,
    /build-test:\n[\s\S]*?if: github\.ref != 'refs\/heads\/main' \|\| \(github\.event_name != 'push' && github\.event_name != 'workflow_dispatch'\)[\s\S]*?permissions:\n {6}contents: read/,
  );
  assert.match(
    workflow,
    /build-test-push:\n[\s\S]*?if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\)[\s\S]*?permissions:\n {6}actions: write\n {6}contents: write\n {6}packages: write\n {6}pull-requests: write/,
  );
  assert.match(
    readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8"),
    /workflow_dispatch:/,
  );
  assert.doesNotMatch(workflow, /git push origin main/);
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
  assert.match(terraform, /HIVE_PROJECTS_ROOT\s*=\s*"\/home\/coder"/);
  assert.ok(filebrowser.includes('filebrowser_version="2.63.18"'));
  assert.ok(
    filebrowser.includes("cd599c34afad0e8e61c577d1061c820bccb7feaa3c5a4477a12db586a1cd93ff"),
  );
  assert.ok(
    filebrowser.includes("29b3935c222d91522874e98dfa33195ee7d2acdac5dfbf37c1361a73704a28de"),
  );
  assert.ok(filebrowser.includes("$HOME/.local/bin/filebrowser"));
  assert.match(filebrowser, /--auth\.method="noauth"/);
  assert.match(filebrowser, /filebrowser_root="\$\{HIVE_PROJECTS_ROOT:-\$HOME\}"/);
  assert.match(filebrowser, /--root="\$filebrowser_root"/);
  assert.match(filebrowser, /users find 1/);
  assert.match(filebrowser, /users add coder .* --perm\.admin/);
  assert.match(filebrowser, /api\/login/);
  assert.match(filebrowser, /login_status/);
  assert.match(filebrowser, /pkill -x filebrowser/);
  assert.doesNotMatch(filebrowser, /\bsudo\b/);
  assert.ok(initScript.includes("Node.js v24"));
  assert.ok(!initScript.includes("also available: 18, 20, 22"));
}

function verifyDockerFileBrowser() {
  const terraform = readFileSync(join(DOCKER_TEMPLATE_ROOT, "main.tf"), "utf8");
  const filebrowser = readFileSync(
    join(DOCKER_TEMPLATE_ROOT, "scripts/tools-filebrowser.sh"),
    "utf8",
  );

  assert.doesNotMatch(terraform, /module "filebrowser"/);
  assert.match(terraform, /resource "coder_script" "filebrowser"/);
  assert.match(terraform, /resource "coder_app" "filebrowser"/);
  assert.match(terraform, /start_blocks_login\s*=\s*false/);
  assert.equal(filebrowser, readTemplateFile("scripts/tools-filebrowser.sh"));
}

function verifyCustomFileBrowserRootCreation() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ai-dev-k8s-filebrowser-"));
  const home = join(fixtureRoot, "home");
  const bin = join(fixtureRoot, "bin");
  const customRoot = join(fixtureRoot, "custom", "projects");
  const filebrowserBin = join(home, ".local", "bin", "filebrowser");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(join(home, ".local", "share"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(filebrowserBin, "#!/bin/sh\nexit 0\n");
  chmodSync(filebrowserBin, 0o755);
  writeFileSync(join(home, ".local", "share", "filebrowser-version"), "2.63.18\n");
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
case "$*" in
  */health*) exit 1 ;;
  *) printf '200' ;;
esac
`,
  );
  chmodSync(join(bin, "curl"), 0o755);

  const result = spawnSync("bash", [join(TEMPLATE_ROOT, "scripts/tools-filebrowser.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      HIVE_PROJECTS_ROOT: customRoot,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /File Browser 2\.63\.18 started/);
  assert.equal(statSync(customRoot).isDirectory(), true);
}

function verifyAiAgentSelection() {
  const script = readTemplateFile("scripts/tools-ai.sh");
  const terraform = readTemplateFile("main.tf");
  const initScript = readTemplateFile("scripts/init.sh");
  const agentInstructions = readTemplateFile("CLAUDE.md");

  assert.ok(script.includes('npm_global_has "@openai/codex" && command_exists codex'));
  assert.ok(terraform.includes('module "claude-code"'));
  assert.ok(!terraform.includes('resource "coder_app" "gsd"'));

  for (const content of [script, terraform, initScript]) {
    assert.ok(!content.toLowerCase().includes("opengsd"));
    assert.ok(!content.toLowerCase().includes("gsd-pi"));
    assert.ok(!content.toLowerCase().includes("get-shit-done"));
    assert.ok(!content.includes("game-development"));
    assert.ok(!content.includes("electronics-design"));
    assert.ok(!content.includes("kicad-development"));
  }
  assert.doesNotMatch(terraform, /sync-vault|vault_repo|mcpvault/);
  assert.equal(existsSync(join(TEMPLATE_ROOT, "codex")), false);
  assert.match(agentInstructions, /only vendor-published or OpenAI-curated skills and plugins/);
}

function verifyCuratedAgentCapabilities() {
  const script = readTemplateFile("scripts/tools-ai.sh");
  const readme = readTemplateFile("README.md");

  assert.match(script, /skills_cli_version="1\.5\.20"/);
  assert.match(script, /openai_skills_ref="[0-9a-f]{40}"/);
  assert.match(script, /vercel_skills_ref="[0-9a-f]{40}"/);
  assert.match(script, /plugins_ref="[0-9a-f]{40}"/);
  assert.doesNotMatch(script, /openai_skills_ref="(?:main|latest)"/);
  assert.doesNotMatch(script, /vercel_skills_ref="(?:main|latest)"/);
  assert.doesNotMatch(script, /plugins_ref="(?:main|latest)"/);

  for (const skill of [
    "cloudflare-deploy",
    "security-best-practices",
    "security-threat-model",
    "react-best-practices",
    "composition-patterns",
    "web-design-guidelines",
  ]) {
    assert.ok(script.includes(skill), `${skill} must be provisioned`);
    assert.ok(readme.includes(skill), `${skill} must be documented`);
  }

  assert.match(script, /https:\/\/github\.com\/openai\/skills\.git/);
  assert.match(script, /https:\/\/github\.com\/vercel-labs\/agent-skills\.git/);
  assert.match(script, /local -a skill_sources=\(\)/);
  assert.match(
    script,
    /if ! checkout_pinned_repo "\$openai_root"[\s\S]*?else\s+skill_sources\+=\([\s\S]*?cloudflare-deploy[\s\S]*?security-best-practices[\s\S]*?security-threat-model[\s\S]*?\)\s+fi/,
  );
  assert.match(
    script,
    /if ! checkout_pinned_repo "\$vercel_root"[\s\S]*?else\s+skill_sources\+=\([\s\S]*?react-best-practices[\s\S]*?composition-patterns[\s\S]*?web-design-guidelines[\s\S]*?\)\s+fi/,
  );
  assert.match(script, /--agent claude-code/);
  assert.match(script, /--agent codex/);
  assert.match(script, /\.agents\/skills\/\.hive-official/);
  assert.match(script, /https:\/\/github\.com\/openai\/plugins\.git/);
  assert.match(script, /github@\$marketplace_name/);
  assert.match(script, /"name": "hive-openai-official"/);
  assert.match(readme, /Playwright remains an MCP server rather than a[\s\S]*duplicated skill/);
}

function verifyGameDevelopmentTooling() {
  const terraform = readTemplateFile("main.tf");
  const dockerfile = readFileSync(join(process.cwd(), "docker/hive-base/Dockerfile"), "utf8");
  const claudeMcp = readFileSync(join(process.cwd(), "docker/hive-base/claude-mcp.json"), "utf8");
  const obsidianDesktop = readFileSync(
    join(process.cwd(), "docker/hive-base/obsidian.desktop"),
    "utf8",
  );
  assert.match(dockerfile, /UnityHubSetup-3\.19\.5-amd64\.deb/);
  assert.match(dockerfile, /5a5b57adc9ce20931c4154c57ffded08f3ffa2743286fdf14c9e7add6b212540/);
  assert.match(dockerfile, /BLENDER_VERSION=4\.5\.12/);
  assert.match(dockerfile, /95e3a2dfedba3bd32ca54fc355eac6b15a11986954ccb02815a07535d0120a25/);
  assert.match(
    dockerfile,
    /COPY --chown=coder:coder claude-mcp\.json \/home\/coder\/\.claude\/mcp\.json/,
  );
  assert.match(terraform, /visualstudiotoolsforunity\.vstuc/);
  assert.match(terraform, /ms-dotnettools\.csharp/);
  assert.doesNotMatch(claudeMcp, /obsidian|mcpvault/i);
  assert.doesNotMatch(obsidianDesktop, /\/home\/coder\/vault/);
  assert.match(obsidianDesktop, /^Name=Obsidian$/m);
}

function verifyElectronicsDesignTooling() {
  const terraform = readTemplateFile("main.tf");
  const initScript = readTemplateFile("scripts/init.sh");
  const toolsAi = readTemplateFile("scripts/tools-ai.sh");
  const dockerfile = readFileSync(join(process.cwd(), "docker/hive-base/Dockerfile"), "utf8");
  const workflow = readFileSync(
    join(process.cwd(), ".github/workflows/build-base-image.yml"),
    "utf8",
  );
  assert.match(dockerfile, /^\s*kicad \\/m);
  assert.match(dockerfile, /^\s*kicad-libraries \\/m);
  assert.match(dockerfile, /^\s*kicad-packages3d \\/m);
  assert.equal(workflow.match(/kicad-cli version/g)?.length, 2);
  for (const content of [terraform, initScript, toolsAi, dockerfile, workflow]) {
    assert.doesNotMatch(
      content,
      /kicad-mcp-pro|electronics-design|kicad-development|astral-sh\/uv|COPY --from=uv/,
    );
  }
}

function verifyCoderTemplateUploadPaths() {
  const terraform = readTemplateFile("main.tf");
  const references = [
    ...terraform.matchAll(/(?:file|templatefile)\("\$\{path\.module\}\/([^"]+)"/g),
  ].map(([, relativePath]) => relativePath);

  assert.ok(references.length > 0);
  for (const relativePath of references) {
    assert.ok(
      relativePath.split("/").every((part) => !part.startsWith(".")),
      `${relativePath} contains a hidden path that coder templates push will omit`,
    );
    assert.ok(existsSync(join(TEMPLATE_ROOT, relativePath)), `${relativePath} must exist`);
  }
}

function verifyHiveMigrationSafety() {
  const { hiveInit, migrated, result } = runHiveProjectMcpMigrationFixture();

  assert.match(hiveInit, /if ! git -C \/home\/coder\/project checkout -b/);
  assert.match(hiveInit, /keeping the current worktree/);
  assert.equal(result.status, 0, result.stderr);
  assert.equal("obsidian" in migrated.mcpServers, false);
  assert.equal("hive_obsidian" in migrated.mcpServers, false);
  assert.deepEqual(migrated.mcpServers.playwright, { command: "keep-playwright" });
  assert.deepEqual(migrated.mcpServers.custom, { command: "keep-custom" });
  assert.deepEqual(migrated.customMetadata, { retained: true });
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
  const { bin, calls, home, manifest } = createBootstrapFixture();

  const env = {
    ...process.env,
    GH_CALLS: calls,
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
  const second = spawnSync("bash", [script], { encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 2);
  assert.match(second.stdout, /repository bootstrap complete/);
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
test(
  "workspace bootstrap removes vault integration without deleting vault data",
  verifySafeBootstrap,
);
test(
  "workspace migration removes only manifest-owned vault context",
  verifyVaultManagedContextCleanup,
);
test("workspace migration replaces read-only persisted MCP configs", verifyReadOnlyMcpMigration);
test("base image rollout updates the pinned template digest through a PR", verifyBaseImageRollout);
test("supplemental tools support the non-root workspace", verifyNonRootSupplementalTools);
test("Docker workspaces use the same repairable File Browser runtime", verifyDockerFileBrowser);
test(
  "File Browser creates a configured projects root before startup",
  verifyCustomFileBrowserRootCreation,
);
test("workspace only provisions Claude and Codex AI agents", verifyAiAgentSelection);
test(
  "workspace provisions pinned official skills and the OpenAI GitHub plugin",
  verifyCuratedAgentCapabilities,
);
test(
  "workspace provisions official Unity and Blender applications without custom skills",
  verifyGameDevelopmentTooling,
);
test(
  "workspace provisions official KiCad tooling without custom skills or MCP servers",
  verifyElectronicsDesignTooling,
);
test(
  "Coder template uploads include every Terraform file dependency",
  verifyCoderTemplateUploadPaths,
);
test(
  "Hive migration preserves project MCP data and tolerates checkout failures",
  verifyHiveMigrationSafety,
);
test("shell setup retries incomplete Oh My Zsh installations", verifyShellRetry);
test("GitHub helpers retrieve fresh Coder credentials on demand", verifyGithubHelpers);
test("repository manifest only includes approved organizations", verifyRepositoryManifest);
test("repository bootstrap is idempotent", verifyRepositoryBootstrap);
test("repository bootstrap rejects failed external authentication", verifyFailedExternalAuth);

function runReadOnlyMcpMigrationFixture(templateRoot) {
  const initScript = readFileSync(join(templateRoot, "scripts/init.sh"), "utf8");
  const configMatch = initScript.match(/python3 - <<'PYCONFIG'\n([\s\S]*?)\nPYCONFIG/);
  const fixtureRoot = mkdtempSync(join(tmpdir(), "read-only-mcp-"));
  const home = join(fixtureRoot, "home");
  const claudeRoot = join(home, ".claude");
  const claudeMcp = join(claudeRoot, "mcp.json");

  assert.ok(configMatch);
  mkdirSync(claudeRoot, { recursive: true });
  writeFileSync(
    claudeMcp,
    '{"mcpServers":{"obsidian":{"command":"remove"},"custom":{"command":"keep"}}}\n',
  );
  chmodSync(claudeMcp, 0o444);
  const configScript = join(fixtureRoot, "configure.py");
  writeFileSync(configScript, configMatch[1]);
  const result = spawnSync("python3", [configScript], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(readFileSync(claudeMcp, "utf8"));
  assert.equal(migrated.mcpServers.obsidian, undefined);
  assert.equal(migrated.mcpServers.custom.command, "keep");
  assert.equal(migrated.mcpServers.playwright.command, "npx");
  assert.equal(statSync(claudeMcp).mode & 0o777, 0o600);
}

function verifyReadOnlyMcpMigration() {
  for (const templateRoot of [DOCKER_TEMPLATE_ROOT, join(process.cwd(), "templates/hive")]) {
    runReadOnlyMcpMigrationFixture(templateRoot);
  }
}

function runHiveProjectMcpMigrationFixture() {
  const hiveInit = readFileSync(join(process.cwd(), "templates/hive/scripts/init.sh"), "utf8");
  const configMatch = hiveInit.match(/python3 - <<'PYCONFIG'\n([\s\S]*?)\nPYCONFIG/);
  const fixtureRoot = mkdtempSync(join(tmpdir(), "hive-project-mcp-"));
  const home = join(fixtureRoot, "home");
  const projectMcp = join(home, "project", ".gsd", "mcp.json");

  assert.ok(configMatch);
  mkdirSync(join(home, "project", ".gsd"), { recursive: true });
  writeFileSync(
    projectMcp,
    `${JSON.stringify({
      mcpServers: {
        obsidian: { command: "obsolete" },
        hive_obsidian: { command: "obsolete" },
        playwright: { command: "keep-playwright" },
        custom: { command: "keep-custom" },
      },
      customMetadata: { retained: true },
    })}\n`,
  );

  const configScript = join(fixtureRoot, "configure.py");
  writeFileSync(configScript, configMatch[1]);
  const result = spawnSync("python3", [configScript], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });

  return { hiveInit, migrated: JSON.parse(readFileSync(projectMcp, "utf8")), result };
}
