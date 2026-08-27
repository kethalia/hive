/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are isolated under mkdtemp fixtures. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const templateRoot = join(repositoryRoot, "templates", "technical-interview");
const bootstrapScript = join(templateRoot, "bootstrap.sh");
const cloneScript = join(templateRoot, "scripts", "clone-repositories.sh");
const initScript = join(templateRoot, "scripts", "init.sh");
const toolsBrowserScript = join(templateRoot, "scripts", "tools-browser.sh");
const toolsCiScript = join(templateRoot, "scripts", "tools-ci.sh");
const toolsFilebrowserScript = join(templateRoot, "scripts", "tools-filebrowser.sh");
const expectedOrigin = "https://github.com/prmsolutions/interview-template.git";
const claudeCredentialAssertions = [
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
]
  .map((name) => `[ -z "\${${name}:-}" ]`)
  .join("\n");

function executable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function git(...args) {
  const result = spawnSync("/usr/bin/git", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function seedSafeInterviewEnvironment(home) {
  const environmentDirectory = join(home, ".config", "hive");
  mkdirSync(environmentDirectory, { recursive: true });
  const environmentFile = join(environmentDirectory, "interview-env.sh");
  writeFileSync(
    environmentFile,
    "# hive-managed-interview-environment:v1\n" +
      "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN\n" +
      "unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_OAUTH_REFRESH_TOKEN CLAUDE_CODE_OAUTH_SCOPES\n" +
      "unset GH_TOKEN GITHUB_TOKEN CODER_AGENT_TOKEN CODER_SESSION_TOKEN\n" +
      "unset REALM_VISUAL_REVIEW_API_KEY RUNCOMFY_API_TOKEN\n",
  );
  chmodSync(environmentFile, 0o600);

  for (const shellFile of [".zshenv", ".bashrc", ".profile"]) {
    writeFileSync(
      join(home, shellFile),
      "# hive-interview-environment\n" +
        '[ ! -f "$HOME/.config/hive/interview-env.sh" ] || . "$HOME/.config/hive/interview-env.sh"\n' +
        "__hive_interview_preserved_startup() {\n" +
        "  :\n" +
        "# >>> hive-interview-preserved-startup\n" +
        "# <<< hive-interview-preserved-startup\n" +
        "}\n" +
        "__hive_interview_preserved_startup\n" +
        "unset -f __hive_interview_preserved_startup 2>/dev/null || true\n" +
        "# hive-interview-environment-final\n" +
        '[ ! -f "$HOME/.config/hive/interview-env.sh" ] || . "$HOME/.config/hive/interview-env.sh"\n',
    );
  }
}

function renderInitScript() {
  return readFileSync(initScript, "utf8")
    .replace(`\${workspace_readme_content}`, "Technical interview fixture")
    .replace(`\${workspace_name}`, "fixture-interview")
    .replace(`\${enable_browser}`, "true")
    .replace(`\${claude_md_content}`, "Technical interview fixture agent context")
    .replaceAll("$${", "${");
}

function renderToolsCiScript(cloneContents, manifestContents, bootstrapContents) {
  const placeholder = (name) => `\${${name}}`;
  return readFileSync(toolsCiScript, "utf8")
    .replace(
      placeholder("clone_repositories_script_b64"),
      Buffer.from(cloneContents).toString("base64"),
    )
    .replace(
      placeholder("repositories_manifest_b64"),
      Buffer.from(manifestContents).toString("base64"),
    )
    .replace(placeholder("bootstrap_script_b64"), Buffer.from(bootstrapContents).toString("base64"))
    .replaceAll("$${", "${");
}

function renderToolsBrowserScript(chromeBinary) {
  return readFileSync(toolsBrowserScript, "utf8").replace(
    'CHROME_BIN="/usr/bin/google-chrome-stable"',
    `CHROME_BIN="${chromeBinary}"`,
  );
}

function renderToolsFilebrowserScript(trustedPath) {
  return readFileSync(toolsFilebrowserScript, "utf8").replace(
    'INTERVIEW_TRUSTED_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    `INTERVIEW_TRUSTED_PATH="${trustedPath}"`,
  );
}

function runInit(root, home) {
  const renderedInit = join(root, "rendered-init.sh");
  writeFileSync(renderedInit, renderInitScript());
  return run("bash", [renderedInit], {
    ...process.env,
    BASH_ENV: "",
    ENV: "",
    HIVE_EXPECTED_IMAGE_VARIANT: "browser",
    HIVE_IMAGE_VARIANT: "browser",
    HOME: home,
    PATH: "/usr/bin:/bin",
  });
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-template-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const tmuxRoot = join(root, "tmux");
  const calls = join(root, "calls.log");
  const claudeArgs = join(root, "claude-args.log");
  const interviewRepository = join(home, "projects", "prmsolutions", "interview-template");
  mkdirSync(join(interviewRepository, "backend", "tests"), { recursive: true });
  mkdirSync(join(interviewRepository, "frontend"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(tmuxRoot, { recursive: true });
  seedSafeInterviewEnvironment(home);
  writeFileSync(calls, "");
  writeFileSync(
    join(interviewRepository, ".gitignore"),
    ".venv/\nnode_modules/\ndist/\n__pycache__/\n.pytest_cache/\n",
  );
  writeFileSync(
    join(interviewRepository, "backend", "requirements.txt"),
    "fastapi>=0.115.0\nuvicorn[standard]>=0.30.0\npytest>=8.0.0\nhttpx>=0.27.0\n",
  );
  writeFileSync(join(interviewRepository, "backend", "app.py"), "app = object()\n");
  writeFileSync(
    join(interviewRepository, "backend", "tests", "test_hello.py"),
    "def test_ok(): pass\n",
  );
  writeFileSync(
    join(interviewRepository, "frontend", "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-frontend",
        private: true,
        scripts: { build: "vite build", dev: "vite" },
      },
      null,
      2,
    )}\n`,
  );

  git("-C", interviewRepository, "init", "--quiet");
  git("-C", interviewRepository, "config", "user.name", "Fixture");
  git("-C", interviewRepository, "config", "user.email", "fixture@example.test");
  git("-C", interviewRepository, "remote", "add", "origin", expectedOrigin);
  git("-C", interviewRepository, "add", ".");
  git("-C", interviewRepository, "commit", "--quiet", "-m", "fixture");
  const commit = git("-C", interviewRepository, "rev-parse", "HEAD");

  executable(
    join(bin, "python3"),
    `#!/bin/bash
set -euo pipefail
[ -z "\${CODER_AGENT_TOKEN:-}" ]
${claudeCredentialAssertions}
if [ "\${1:-}" = "--version" ]; then printf 'Python 3.13.5\\n'; exit 0; fi
if [ "\${1:-}" = "-" ]; then exec /usr/bin/python3 -; fi
if [ "\${1:-}" = "-c" ]; then
  case "\${2:-}" in
    *sysconfig.get_config_var*)
      printf '%s\\n' "\${FAKE_PYTHON_RUNTIME:-3.13.5|cache:cpython-313|abi:cpython-313-x86_64-linux-gnu}"
      ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "venv" ]; then
  [ "\${FAKE_STANDARD_VENV_FAIL:-0}" != "1" ] || exit 1
  target=$3
  mkdir -p "$target/bin"
  cat > "$target/bin/python" <<'PYTHON'
#!/bin/bash
set -euo pipefail
[ -z "\${CODER_AGENT_TOKEN:-}" ]
${claudeCredentialAssertions}
if [ "\${1:-}" = "--version" ]; then printf 'Python 3.13.5\\n'; exit 0; fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "pip" ]; then
  printf 'pip-install\\n' >> "$FAKE_CALLS"
fi
exit 0
PYTHON
  cat > "$target/bin/pytest" <<'PYTEST'
#!/bin/bash
[ -z "\${CODER_AGENT_TOKEN:-}" ]
${claudeCredentialAssertions}
printf 'pytest\\n' >> "$FAKE_CALLS"
[ "\${FAKE_PYTEST_FAIL:-0}" != "1" ]
PYTEST
  cat > "$target/bin/uvicorn" <<'UVICORN'
#!/bin/bash
while :; do sleep 60; done
UVICORN
  chmod 755 "$target/bin/python" "$target/bin/pytest" "$target/bin/uvicorn"
  exit 0
fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "pip" ]; then
  shift 2
  target=''
  while (($# > 0)); do
    case "$1" in
      --target)
        target=$2
        shift 2
        ;;
      *) shift ;;
    esac
  done
  [ -n "$target" ]
  printf 'virtualenv-fallback-install\\n' >> "$FAKE_CALLS"
  mkdir -p "$target/virtualenv"
  printf '# fixture virtualenv entrypoint\\n' > "$target/virtualenv/__main__.py"
  : > "$target/.hive-fixture-complete"
  exit 0
fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "virtualenv" ]; then
  [ -f "\${PYTHONPATH:-}/virtualenv/__main__.py" ]
  [ -f "\${PYTHONPATH:-}/.hive-fixture-complete" ]
  if [ "\${3:-}" = "--version" ]; then
    printf 'virtualenv 20.35.4 from %s\\n' "$PYTHONPATH/virtualenv/__init__.py"
    exit 0
  fi
  FAKE_STANDARD_VENV_FAIL=0 "$0" -m venv "$3"
  exit 0
fi
printf 'unexpected python3 invocation: %s\\n' "$*" >&2
exit 2
`,
  );
  executable(
    join(bin, "node"),
    `#!/bin/bash
[ -z "\${CODER_AGENT_TOKEN:-}" ]
${claudeCredentialAssertions}
case "\${1:-}" in
  --version) printf '%s\\n' "\${FAKE_NODE_VERSION:-v24.19.0}" ;;
  -e) ;;
  -p) printf '%s|abi:%s\\n' "\${FAKE_NODE_VERSION:-v24.19.0}" "\${FAKE_NODE_ABI:-137}" ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    join(bin, "npm"),
    `#!/bin/bash
set -euo pipefail
[ -z "\${CODER_AGENT_TOKEN:-}" ]
${claudeCredentialAssertions}
case "\${1:-}" in
  --version) printf '11.17.0\\n' ;;
  ls)
    [ ! -e node_modules/.hive-fixture-incomplete ]
    ;;
  install|ci)
    shift
    install_prefix=''
    package_spec=''
    while (($# > 0)); do
      case "$1" in
        --prefix)
          install_prefix=$2
          shift 2
          ;;
        @*|pnpm@*)
          package_spec=$1
          shift
          ;;
        *)
          shift
          ;;
      esac
    done
    if [ -n "$install_prefix" ]; then
      printf 'tool-install:%s\\n' "$package_spec" >> "$FAKE_CALLS"
      case "$package_spec" in
        @openai/codex@*)
          mkdir -p "$install_prefix/node_modules/.bin"
          printf '#!/bin/sh\\nprintf "codex-cli 0.149.1\\\\n"\\n' > "$install_prefix/node_modules/.bin/codex"
          chmod 755 "$install_prefix/node_modules/.bin/codex"
          ;;
        @playwright/mcp@*)
          mkdir -p "$install_prefix/node_modules/.bin"
          printf '#!/bin/sh\\nprintf "Version 0.0.79\\\\n"\\n' > "$install_prefix/node_modules/.bin/playwright-mcp"
          chmod 755 "$install_prefix/node_modules/.bin/playwright-mcp"
          ;;
        @oven/bun-linux-x64@*)
          mkdir -p "$install_prefix/node_modules/@oven/bun-linux-x64/bin"
          printf '#!/bin/sh\\nprintf "1.4.0\\\\n"\\n' > "$install_prefix/node_modules/@oven/bun-linux-x64/bin/bun"
          chmod 755 "$install_prefix/node_modules/@oven/bun-linux-x64/bin/bun"
          ;;
        pnpm@*)
          mkdir -p "$install_prefix/node_modules/.bin"
          printf '#!/bin/sh\\nprintf "10.32.1\\\\n"\\n' > "$install_prefix/node_modules/.bin/pnpm"
          chmod 755 "$install_prefix/node_modules/.bin/pnpm"
          ;;
        *) exit 2 ;;
      esac
    else
      printf 'npm-install\\n' >> "$FAKE_CALLS"
      mkdir -p node_modules/.bin
      rm -f node_modules/.hive-fixture-incomplete
      printf '#!/bin/sh\\nexit 0\\n' > node_modules/.bin/vite
      chmod 755 node_modules/.bin/vite
    fi
    ;;
  run)
    case "\${2:-}" in
      build)
        printf 'npm-build\\n' >> "$FAKE_CALLS"
        [ "\${FAKE_BUILD_FAIL:-0}" != "1" ] || exit 1
        mkdir -p dist
        ;;
      dev)
        while :; do sleep 60; done
        ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    join(bin, "git"),
    `#!/bin/bash
set -euo pipefail
[ -z "\${CODER_AGENT_TOKEN:-}" ]
${claudeCredentialAssertions}
for argument in "$@"; do
  if [ "$argument" = "ls-remote" ]; then
    [ "$HOME" != "$FAKE_WORKSPACE_HOME" ]
    [ "$GIT_CONFIG_GLOBAL" = "/dev/null" ]
    [ "$GIT_CONFIG_NOSYSTEM" = "1" ]
    [ "$GIT_ASKPASS" = "/bin/false" ]
    [ "$GIT_SSH_COMMAND" = "/bin/false" ]
    [ "$SSH_ASKPASS" = "/bin/false" ]
    [ -z "\${GIT_CONFIG:-}" ]
    [ -z "\${GIT_CONFIG_COUNT:-}" ]
    [ -z "\${GIT_CONFIG_PARAMETERS:-}" ]
    [ -z "\${SSH_AUTH_SOCK:-}" ]
    [ -z "\${SSH_AGENT_PID:-}" ]
    printf '%s\\tHEAD\\n' "$FAKE_REMOTE_COMMIT"
    exit 0
  fi
done
exec /usr/bin/git "$@"
`,
  );
  executable(
    join(bin, "curl"),
    `#!/bin/sh
exit 0
`,
  );
  executable(
    join(bin, "claude"),
    `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then printf '2.1.170 (Claude Code)\\n'; exit 0; fi
[ "\${ANTHROPIC_API_KEY:-}" = "\${EXPECTED_CLAUDE_KEY:-}" ]
${claudeCredentialAssertions}
[ -z "\${GH_TOKEN:-}" ]
[ -z "\${GITHUB_TOKEN:-}" ]
[ -z "\${CODER_AGENT_TOKEN:-}" ]
[ -z "\${CODER_SESSION_TOKEN:-}" ]
[ -z "\${REALM_VISUAL_REVIEW_API_KEY:-}" ]
[ -z "\${RUNCOMFY_API_TOKEN:-}" ]
printf '<%s>\\n' "$@" > "$CLAUDE_ARGS_LOG"
`,
  );
  executable(join(bin, "google-chrome-stable"), "#!/bin/sh\nprintf 'Google Chrome 140\\n'\n");
  executable(join(bin, "sqlite3"), "#!/bin/sh\nprintf '3.46.1\\n'\n");
  executable(join(bin, "rg"), "#!/bin/sh\nprintf 'ripgrep 14.1.1\\n'\n");
  executable(
    join(bin, "tmux"),
    `#!/bin/bash
set -euo pipefail
state=$FAKE_TMUX_STATE
session_file="$state/session"
windows_file="$state/windows"
mkdir -p "$state"
command_name=\${1:-}
shift || true
printf 'tmux:%s %s\\n' "$command_name" "$*" >> "$FAKE_CALLS"
case "$command_name" in
  -V)
    printf 'tmux 3.5a\\n'
    ;;
  has-session)
    [ -f "$session_file" ]
    ;;
  new-session)
    window_name=work
    while (($# > 0)); do
      if [ "$1" = "-n" ]; then window_name=$2; shift 2; else shift; fi
    done
    : > "$session_file"
    printf '%s\\n' "$window_name" > "$windows_file"
    ;;
  list-windows)
    cat "$windows_file"
    ;;
  new-window)
    window_name=''
    while (($# > 0)); do
      if [ "$1" = "-n" ]; then window_name=$2; shift 2; else shift; fi
    done
    grep -Fqx -- "$window_name" "$windows_file" || printf '%s\\n' "$window_name" >> "$windows_file"
    ;;
  list-panes)
    printf '0\\n'
    ;;
  show-environment)
    exit 1
    ;;
  set-option|set-environment|select-window|respawn-window)
    ;;
  kill-session|kill-server)
    rm -f "$session_file" "$windows_file"
    ;;
  *)
    printf 'unexpected tmux command: %s %s\\n' "$command_name" "$*" >&2
    exit 2
    ;;
esac
`,
  );
  executable(
    join(bin, "gh"),
    `#!/bin/sh
if [ "$*" = "auth status --json hosts" ]; then
  if [ -n "\${FAKE_GH_AUTH_JSON:-}" ]; then
    printf '%s\\n' "$FAKE_GH_AUTH_JSON"
  else
    printf '{"hosts":{}}\\n'
  fi
  exit "\${FAKE_GH_AUTH_EXIT:-0}"
fi
exit 1
`,
  );
  executable(
    join(bin, "coder"),
    `#!/bin/sh
[ -z "\${CODER_AGENT_TOKEN:-}" ]
[ -z "\${CODER_SESSION_TOKEN:-}" ]
case "\${FAKE_CODER_AUTH_STATE:-unauthenticated}" in
  authenticated)
    printf '{"username":"fixture"}\\n'
    exit 0
    ;;
  unauthenticated)
    printf 'error: You are not logged in.\\n' >&2
    exit 1
    ;;
  unavailable)
    printf 'error: dial tcp: connection refused\\n' >&2
    exit 1
    ;;
  timeout)
    exit 124
    ;;
  *) exit 2 ;;
esac
`,
  );

  const env = {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: "must-not-reach-child-processes",
    CLAUDE_ARGS_LOG: claudeArgs,
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "must-not-reach-child-processes",
    CLAUDE_CODE_OAUTH_SCOPES: "must-not-reach-child-processes",
    CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-child-processes",
    CODER_AGENT_TOKEN: "must-not-reach-child-processes",
    FAKE_CALLS: calls,
    FAKE_REMOTE_COMMIT: commit,
    FAKE_TMUX_STATE: tmuxRoot,
    FAKE_WORKSPACE_HOME: home,
    HOME: home,
    HIVE_INTERVIEW_SKIP_AUTOSTART: "true",
    PATH: `${join(home, ".local", "bin")}:${bin}:/usr/bin:/bin`,
  };
  for (const variableName of [
    "ANTHROPIC_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "CODER_SESSION_TOKEN",
    "REALM_VISUAL_REVIEW_API_KEY",
    "RUNCOMFY_API_TOKEN",
  ]) {
    delete env[variableName];
  }

  return { bin, calls, claudeArgs, commit, env, home, interviewRepository, root };
}

function run(command, args, env) {
  return spawnSync(command, args, { encoding: "utf8", env, timeout: 30_000 });
}

function installHelpers(fixture) {
  const result = run("bash", [bootstrapScript], fixture.env);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function stopTmux(fixture) {
  run("tmux", ["kill-server"], fixture.env);
}

function filesRecursively(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test("standalone Terraform exposes interview apps without personal auth modules", () => {
  const terraform = readFileSync(join(templateRoot, "main.tf"), "utf8");
  const init = readFileSync(join(templateRoot, "scripts", "init.sh"), "utf8");
  const toolsBrowser = readFileSync(join(templateRoot, "scripts", "tools-browser.sh"), "utf8");
  const toolsCi = readFileSync(join(templateRoot, "scripts", "tools-ci.sh"), "utf8");
  const toolsFilebrowser = readFileSync(
    join(templateRoot, "scripts", "tools-filebrowser.sh"),
    "utf8",
  );
  const profile = JSON.parse(readFileSync(join(templateRoot, "profile.json"), "utf8"));
  const toolsCiResource = terraform.match(
    /resource "coder_script" "tools_ci" \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.doesNotMatch(terraform, /coder_external_auth/);
  assert.doesNotMatch(terraform, /coder-login/);
  assert.doesNotMatch(terraform, /git-commit-signing|module "git-config"/);
  assert.doesNotMatch(terraform, /module "claude-code"/);
  assert.doesNotMatch(terraform, /WORKSPACE_ROUTING\.md/);
  assert.doesNotMatch(terraform, /scripts\/tools-ai\.sh/);
  assert.doesNotMatch(terraform, /\bBASH_ENV\b/);
  assert.doesNotMatch(terraform, /^\s+ENV\s*=/m);
  assert.doesNotMatch(terraform, /\.hive-image-seeded/);
  assert.match(
    terraform,
    /find \/target -mindepth 1 -maxdepth 1 ! -name lost\+found -print -quit[\s\S]*?Preserving existing workspace home/,
  );
  assert.doesNotMatch(init, /sync-vault|vault-managed|Vault Context Layer/);
  assert.doesNotMatch(init, /command = "npx"|"command": "npx"/);
  assert.match(init, /\.local[^\n]+playwright-mcp/);
  assert.match(init, /"--browser", "chrome", "--no-sandbox", "--isolated"/);
  assert.match(init, /unset[^\n]+CODER_AGENT_TOKEN/);
  assert.match(toolsBrowser, /unset[^\n]+CODER_AGENT_TOKEN/);
  assert.match(toolsCi, /unset[^\n]+CODER_AGENT_TOKEN/);
  assert.match(toolsFilebrowser, /unset[^\n]+CODER_AGENT_TOKEN/);
  assert.match(toolsBrowser, /INTERVIEW_TRUSTED_PATH="\/usr\/local\/sbin:[^"]+"/);
  assert.match(toolsFilebrowser, /INTERVIEW_TRUSTED_PATH="\/usr\/local\/sbin:[^"]+"/);
  assert.match(toolsCiResource ?? "", /start_blocks_login\s*=\s*false/);
  assert.match(
    terraform,
    /resource "coder_app" "interview_app"[\s\S]*?url\s*=\s*"http:\/\/localhost:3000"[\s\S]*?share\s*=\s*"owner"/,
  );
  assert.match(
    terraform,
    /resource "coder_app" "api_docs"[\s\S]*?url\s*=\s*"http:\/\/localhost:8000\/docs"[\s\S]*?share\s*=\s*"owner"/,
  );
  assert.equal(profile.id, "interview");
  assert.equal(profile.image_variant, "browser");
  assert.equal(profile.security, undefined);
  assert.equal(profile.applications, undefined);
});

test("home seeding ignores filesystem metadata but never overwrites persisted files", () => {
  const terraform = readFileSync(join(templateRoot, "main.tf"), "utf8");
  const encodedCommand = terraform.match(
    /name\s*=\s*"seed-home"[\s\S]*?command\s*=\s*\[[\s\S]*?"sh",\s*"-c",\s*"((?:\\.|[^"\\])*)"/,
  )?.[1];
  assert.ok(encodedCommand, "seed-home shell command must be present");

  const root = mkdtempSync(join(tmpdir(), "technical-interview-seed-home-"));
  const imageHome = join(root, "image-home");
  const target = join(root, "target");
  mkdirSync(join(imageHome, ".claude"), { recursive: true });
  mkdirSync(join(target, "lost+found"), { recursive: true });
  writeFileSync(join(imageHome, ".claude", "fixture"), "image configuration\n");
  writeFileSync(join(imageHome, ".profile"), "image profile\n");
  writeFileSync(join(target, "lost+found", "filesystem-metadata"), "preserve metadata\n");

  const seedCommand = JSON.parse(`"${encodedCommand}"`)
    .replaceAll("/home/coder", imageHome)
    .replaceAll("/target", target);
  const first = run("sh", ["-c", seedCommand], process.env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(target, ".claude", "fixture"), "utf8"), "image configuration\n");
  assert.equal(
    readFileSync(join(target, "lost+found", "filesystem-metadata"), "utf8"),
    "preserve metadata\n",
  );

  writeFileSync(join(target, ".profile"), "candidate profile\n");
  const second = run("sh", ["-c", seedCommand], process.env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(target, ".profile"), "utf8"), "candidate profile\n");
});

test("init atomically replaces the managed environment symlink without touching its target", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-init-env-"));
  const home = join(root, "home");
  const environmentDirectory = join(home, ".config", "hive");
  const environmentFile = join(environmentDirectory, "interview-env.sh");
  const candidateFile = join(root, "candidate-owned.txt");
  mkdirSync(environmentDirectory, { recursive: true });
  writeFileSync(candidateFile, "preserve candidate work\n");
  chmodSync(candidateFile, 0o644);
  symlinkSync(candidateFile, environmentFile);

  const first = runInit(root, home);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(candidateFile, "utf8"), "preserve candidate work\n");
  assert.equal(statSync(candidateFile).mode & 0o777, 0o644);
  assert.equal(lstatSync(environmentFile).isSymbolicLink(), false);
  assert.equal(statSync(environmentFile).mode & 0o777, 0o600);
  assert.match(readFileSync(environmentFile, "utf8"), /unset ANTHROPIC_API_KEY/);

  const second = runInit(root, home);
  assert.equal(second.status, 0, second.stderr);
  for (const shellFile of [".zshenv", ".bashrc", ".profile"]) {
    const contents = readFileSync(join(home, shellFile), "utf8");
    assert.equal(
      contents.split("\n").filter((line) => line === "# hive-interview-environment").length,
      1,
    );
    assert.equal(
      contents.split("\n").filter((line) => line === "# hive-interview-environment-final").length,
      1,
    );
  }
});

test("init preserves a non-regular workspace README without blocking startup", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-init-readme-"));
  const home = join(root, "home");
  const readme = join(home, "README.md");
  mkdirSync(home, { recursive: true });
  const fifo = run("/usr/bin/mkfifo", [readme], process.env);
  assert.equal(fifo.status, 0, fifo.stderr);

  const result = runInit(root, home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /unsafe workspace README was preserved/);
  assert.equal(lstatSync(readme).isFIFO(), true);
  assert.equal(lstatSync(join(home, ".workspace_initialized")).isFile(), true);
});

test("init preserves non-directory agent configuration paths", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-init-agent-paths-"));
  const home = join(root, "home");
  const codexPath = join(home, ".codex");
  const claudePath = join(home, ".claude");
  mkdirSync(home, { recursive: true });
  writeFileSync(codexPath, "preserve candidate Codex path\n");
  writeFileSync(claudePath, "preserve candidate Claude path\n");

  const result = runInit(root, home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /preserving unsafe agent path without refreshing context/);
  assert.equal(readFileSync(codexPath, "utf8"), "preserve candidate Codex path\n");
  assert.equal(readFileSync(claudePath, "utf8"), "preserve candidate Claude path\n");
});

test("init preserves candidate files at retired vault integration paths", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-retired-vault-"));
  const home = join(root, "home");
  const hiveTarget = join(root, "candidate-hive-config");
  const autostartTarget = join(root, "candidate-autostart-config");
  const syncVault = join(home, "sync-vault.sh");
  mkdirSync(join(home, ".config"), { recursive: true });
  mkdirSync(hiveTarget);
  mkdirSync(autostartTarget);
  writeFileSync(syncVault, "# candidate-owned helper\n");
  writeFileSync(join(hiveTarget, "vault-repository"), "candidate repository setting\n");
  writeFileSync(join(autostartTarget, "obsidian.desktop"), "candidate desktop entry\n");
  symlinkSync(hiveTarget, join(home, ".config", "hive"));
  symlinkSync(autostartTarget, join(home, ".config", "autostart"));

  const result = runInit(root, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(syncVault, "utf8"), "# candidate-owned helper\n");
  assert.equal(
    readFileSync(join(hiveTarget, "vault-repository"), "utf8"),
    "candidate repository setting\n",
  );
  assert.equal(
    readFileSync(join(autostartTarget, "obsidian.desktop"), "utf8"),
    "candidate desktop entry\n",
  );
  assert.equal(lstatSync(join(home, ".config", "hive")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(home, ".config", "autostart")).isSymbolicLink(), true);
});

test("init prepends credential scrubbing before existing shell startup code", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-init-shell-order-"));
  const home = join(root, "home");
  const capture = join(root, "shell-capture");
  const restoreCredentials = join(root, "restore-credentials.sh");
  const forbiddenCredentials = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "CODER_AGENT_TOKEN",
    "CODER_SESSION_TOKEN",
    "REALM_VISUAL_REVIEW_API_KEY",
    "RUNCOMFY_API_TOKEN",
  ];
  const candidateLine = `printf '%s\\n' "\${CODER_AGENT_TOKEN:-absent}" > "$SHELL_CAPTURE"`;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    restoreCredentials,
    `${forbiddenCredentials
      .map((credentialName) => `export ${credentialName}=restored-by-startup`)
      .join("\n")}\n`,
  );

  const shellFiles = [".zshenv", ".bashrc", ".profile", ".bash_profile", ".bash_login"];
  for (const shellFile of shellFiles) {
    writeFileSync(join(home, shellFile), `${candidateLine}\n. "$SHELL_RESTORE_FILE"\nreturn 0\n`);
  }

  const first = runInit(root, home);
  assert.equal(first.status, 0, first.stderr);
  for (const shellFile of shellFiles) {
    const shellPath = join(home, shellFile);
    const contents = readFileSync(shellPath, "utf8");
    assert.equal(contents.split("\n")[0], "# hive-interview-environment");
    assert.equal(
      contents.split("\n")[1],
      '[ ! -f "$HOME/.config/hive/interview-env.sh" ] || . "$HOME/.config/hive/interview-env.sh"',
    );
    assert.ok(contents.indexOf(candidateLine) > contents.indexOf("# hive-interview-environment"));
    assert.equal(contents.trimEnd().endsWith('interview-env.sh"'), true);

    writeFileSync(capture, "");
    const sourced = run(
      "bash",
      [
        "-c",
        '. "$1"; shift; for credential_name in "$@"; do ! printenv "$credential_name" >/dev/null || exit 1; done',
        "bash",
        shellPath,
        ...forbiddenCredentials,
      ],
      {
        ...process.env,
        ...Object.fromEntries(
          forbiddenCredentials.map((credentialName) => [credentialName, "must-be-scrubbed-first"]),
        ),
        BASH_ENV: "",
        ENV: "",
        HOME: home,
        SHELL_CAPTURE: capture,
        SHELL_RESTORE_FILE: restoreCredentials,
      },
    );
    assert.equal(sourced.status, 0, sourced.stderr);
    assert.equal(readFileSync(capture, "utf8"), "absent\n");
  }

  const unmanagedPrefix = "# candidate-added-before-managed-block";
  const unmanagedSuffix = "# tool-added-after-managed-block";
  for (const shellFile of shellFiles) {
    const shellPath = join(home, shellFile);
    writeFileSync(
      shellPath,
      `${unmanagedPrefix}\n${readFileSync(shellPath, "utf8")}${unmanagedSuffix}\n`,
    );
  }

  const second = runInit(root, home);
  assert.equal(second.status, 0, second.stderr);
  for (const shellFile of shellFiles) {
    const contents = readFileSync(join(home, shellFile), "utf8");
    const preservedStart = contents.indexOf("# >>> hive-interview-preserved-startup");
    const preservedEnd = contents.indexOf("# <<< hive-interview-preserved-startup");
    for (const unmanagedLine of [unmanagedPrefix, unmanagedSuffix]) {
      assert.equal(contents.split(unmanagedLine).length - 1, 1);
      assert.ok(contents.indexOf(unmanagedLine) > preservedStart);
      assert.ok(contents.indexOf(unmanagedLine) < preservedEnd);
    }
  }

  const beforeThirdRun = shellFiles.map((shellFile) => readFileSync(join(home, shellFile), "utf8"));
  const third = runInit(root, home);
  assert.equal(third.status, 0, third.stderr);
  assert.deepEqual(
    shellFiles.map((shellFile) => readFileSync(join(home, shellFile), "utf8")),
    beforeThirdRun,
  );
});

test("startup atomically replaces generated input symlinks without touching their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-inputs-"));
  const home = join(root, "home");
  const renderedToolsCi = join(root, "rendered-tools-ci.sh");
  const generatedFiles = [
    {
      contents: "#!/bin/sh\nexit 0\n",
      mode: 0o700,
      path: join(home, "clone-repositories.sh"),
    },
    {
      contents: "prmsolutions/interview-template|prmsolutions/interview-template\n",
      mode: 0o600,
      path: join(home, "repositories.txt"),
    },
    {
      contents: "#!/bin/sh\nexit 0\n",
      mode: 0o700,
      path: join(home, ".local", "libexec", "hive", "interview-bootstrap"),
    },
  ];
  mkdirSync(join(home, ".local", "libexec", "hive"), { recursive: true });

  for (const [index, generated] of generatedFiles.entries()) {
    const target = join(root, `candidate-target-${index}`);
    writeFileSync(target, `preserve candidate target ${index}\n`);
    chmodSync(target, 0o644);
    symlinkSync(target, generated.path);
    generated.target = target;
  }

  writeFileSync(
    renderedToolsCi,
    renderToolsCiScript(
      generatedFiles[0].contents,
      generatedFiles[1].contents,
      generatedFiles[2].contents,
    ),
  );
  const result = run("bash", [renderedToolsCi], {
    ...process.env,
    BASH_ENV: "",
    ENV: "",
    HOME: home,
    PATH: "/usr/bin:/bin",
  });
  assert.equal(result.status, 0, result.stderr);

  for (const [index, generated] of generatedFiles.entries()) {
    assert.equal(readFileSync(generated.target, "utf8"), `preserve candidate target ${index}\n`);
    assert.equal(statSync(generated.target).mode & 0o777, 0o644);
    assert.equal(lstatSync(generated.path).isSymbolicLink(), false);
    assert.equal(readFileSync(generated.path, "utf8"), generated.contents);
    assert.equal(statSync(generated.path).mode & 0o777, generated.mode);
  }
});

test("startup refuses symlinked managed directory chains before writing generated inputs", () => {
  for (const relativeDirectory of [".local", ".local/bin", ".local/libexec", ".local/state"]) {
    const root = mkdtempSync(join(tmpdir(), "technical-interview-input-directories-"));
    const home = join(root, "home");
    const unsafeDirectory = join(home, relativeDirectory);
    const candidateTarget = join(root, `candidate-${relativeDirectory.replaceAll("/", "-")}`);
    const renderedToolsCi = join(root, "rendered-tools-ci.sh");
    mkdirSync(dirname(unsafeDirectory), { recursive: true });
    mkdirSync(candidateTarget);
    writeFileSync(join(candidateTarget, "candidate.txt"), "preserve candidate directory\n");
    chmodSync(candidateTarget, 0o750);
    symlinkSync(candidateTarget, unsafeDirectory);
    writeFileSync(
      renderedToolsCi,
      renderToolsCiScript(
        "#!/bin/sh\nexit 0\n",
        "prmsolutions/interview-template|prmsolutions/interview-template\n",
        "#!/bin/sh\nexit 0\n",
      ),
    );

    const result = run("bash", [renderedToolsCi], {
      ...process.env,
      BASH_ENV: "",
      ENV: "",
      HOME: home,
      PATH: "/usr/bin:/bin",
    });
    assert.equal(result.status, 0, `${relativeDirectory} must leave the agent accessible`);
    assert.match(result.stderr, /unsafe interview directory was preserved/);
    assert.match(result.stderr, /no generated input was written/);
    assert.equal(existsSync(join(home, "clone-repositories.sh")), false);
    assert.equal(existsSync(join(home, "repositories.txt")), false);
    assert.equal(
      readFileSync(join(candidateTarget, "candidate.txt"), "utf8"),
      "preserve candidate directory\n",
    );
    assert.equal(statSync(candidateTarget).mode & 0o777, 0o750);
    assert.equal(lstatSync(unsafeDirectory).isSymbolicLink(), true);
  }
});

test("bootstrap rejects symlinked managed directory chains without touching their targets", () => {
  for (const relativeDirectory of [".local", ".local/bin", ".local/libexec", ".local/state"]) {
    const fixture = createFixture();
    const unsafeDirectory = join(fixture.home, relativeDirectory);
    const candidateTarget = join(
      fixture.root,
      `candidate-${relativeDirectory.replaceAll("/", "-")}`,
    );
    mkdirSync(dirname(unsafeDirectory), { recursive: true });
    mkdirSync(candidateTarget);
    writeFileSync(join(candidateTarget, "candidate.txt"), "preserve candidate directory\n");
    chmodSync(candidateTarget, 0o750);
    symlinkSync(candidateTarget, unsafeDirectory);

    const result = run("bash", [bootstrapScript], fixture.env);
    assert.equal(result.status, 1, `${relativeDirectory} must stop bootstrap`);
    assert.match(result.stderr, /unsafe interview directory was preserved/);
    assert.equal(
      readFileSync(join(candidateTarget, "candidate.txt"), "utf8"),
      "preserve candidate directory\n",
    );
    assert.equal(statSync(candidateTarget).mode & 0o777, 0o750);
    assert.equal(lstatSync(unsafeDirectory).isSymbolicLink(), true);
  }
});

test("browser setup atomically replaces helper symlinks without touching their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-browser-helpers-"));
  const home = join(root, "home");
  const localBin = join(home, ".local", "bin");
  const fakeChrome = join(root, "google-chrome-stable");
  const hijackMarker = join(root, "candidate-path-command-ran");
  const renderedToolsBrowser = join(root, "rendered-tools-browser.sh");
  mkdirSync(localBin, { recursive: true });
  executable(fakeChrome, "#!/bin/sh\nexit 0\n");
  for (const commandName of ["chmod", "ln", "mktemp", "mv"]) {
    executable(join(localBin, commandName), '#!/bin/sh\n: > "$HIVE_HIJACK_MARKER"\nexit 99\n');
  }

  for (const helperName of ["browser-screenshot", "browser-html"]) {
    const candidateTarget = join(root, `${helperName}-candidate-target`);
    const helper = join(localBin, helperName);
    writeFileSync(candidateTarget, `preserve ${helperName} target\n`);
    chmodSync(candidateTarget, 0o644);
    symlinkSync(candidateTarget, helper);
  }
  writeFileSync(renderedToolsBrowser, renderToolsBrowserScript(fakeChrome));

  const first = run("bash", [renderedToolsBrowser], {
    ...process.env,
    ANTHROPIC_API_KEY: "must-not-reach-browser-tools",
    CODER_AGENT_TOKEN: "must-not-reach-browser-tools",
    CODER_SESSION_TOKEN: "must-not-reach-browser-tools",
    GH_TOKEN: "must-not-reach-browser-tools",
    GITHUB_TOKEN: "must-not-reach-browser-tools",
    HIVE_HIJACK_MARKER: hijackMarker,
    HOME: home,
    PATH: `${localBin}:/usr/bin:/bin`,
  });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(existsSync(hijackMarker), false);
  for (const helperName of ["browser-screenshot", "browser-html"]) {
    const candidateTarget = join(root, `${helperName}-candidate-target`);
    const helper = join(localBin, helperName);
    assert.equal(readFileSync(candidateTarget, "utf8"), `preserve ${helperName} target\n`);
    assert.equal(statSync(candidateTarget).mode & 0o777, 0o644);
    assert.equal(lstatSync(helper).isSymbolicLink(), false);
    assert.equal(statSync(helper).mode & 0o777, 0o755);
    assert.match(readFileSync(helper, "utf8"), /hive-managed-browser-helper:v1/);
  }

  const second = run("bash", [renderedToolsBrowser], {
    ...process.env,
    CODER_AGENT_TOKEN: "must-not-reach-browser-tools",
    HIVE_HIJACK_MARKER: hijackMarker,
    HOME: home,
    PATH: `${localBin}:/usr/bin:/bin`,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(existsSync(hijackMarker), false);
});

test("File Browser installation atomically replaces symlinks without touching their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-filebrowser-install-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const localBin = join(home, ".local", "bin");
  const localShare = join(home, ".local", "share");
  const binary = join(localBin, "filebrowser");
  const versionMarker = join(localShare, "filebrowser-version");
  const binaryTarget = join(root, "candidate-binary");
  const hijackMarker = join(root, "candidate-path-command-ran");
  const markerTarget = join(root, "candidate-version");
  const renderedToolsFilebrowser = join(root, "rendered-tools-filebrowser.sh");
  const runningMarker = join(root, "filebrowser-running");
  mkdirSync(localBin, { recursive: true });
  mkdirSync(localShare, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(binaryTarget, "preserve candidate binary\n");
  writeFileSync(markerTarget, "preserve candidate version\n");
  chmodSync(binaryTarget, 0o644);
  chmodSync(markerTarget, 0o644);
  symlinkSync(binaryTarget, binary);
  symlinkSync(markerTarget, versionMarker);
  executable(join(localBin, "curl"), '#!/bin/sh\n: > "$HIVE_HIJACK_MARKER"\nexit 99\n');

  executable(
    join(bin, "curl"),
    `#!/bin/bash
set -euo pipefail
[ -z "\${CODER_AGENT_TOKEN:-}" ]
${claudeCredentialAssertions}
if [ "\${1:-}" = "-fsSLo" ]; then
  : > "$2"
elif [[ "$*" == *'/health'* ]]; then
  [ -f "$FAKE_FILEBROWSER_RUNNING" ]
elif [[ "$*" == *'/api/login'* ]]; then
  printf '200'
else
  exit 2
fi
`,
  );
  executable(join(bin, "sha256sum"), "#!/bin/sh\nexit 0\n");
  executable(
    join(bin, "tar"),
    `#!/bin/bash
set -euo pipefail
while (($# > 0)); do
  if [ "$1" = "-C" ]; then destination=$2; break; fi
  shift
done
cat > "$destination/filebrowser" <<'FILEBROWSER'
#!/bin/bash
set -euo pipefail
[ -z "\${CODER_AGENT_TOKEN:-}" ]
${claudeCredentialAssertions}
case "\${1:-}" in
  config|users) exit 0 ;;
  *) : > "$FAKE_FILEBROWSER_RUNNING" ;;
esac
FILEBROWSER
chmod 755 "$destination/filebrowser"
`,
  );
  writeFileSync(renderedToolsFilebrowser, renderToolsFilebrowserScript(`${bin}:/usr/bin:/bin`));

  const result = run("bash", [renderedToolsFilebrowser], {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: "must-not-reach-filebrowser-tools",
    CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-filebrowser-tools",
    CODER_AGENT_TOKEN: "must-not-reach-filebrowser-tools",
    CODER_SESSION_TOKEN: "must-not-reach-filebrowser-tools",
    FAKE_FILEBROWSER_RUNNING: runningMarker,
    GH_TOKEN: "must-not-reach-filebrowser-tools",
    GITHUB_TOKEN: "must-not-reach-filebrowser-tools",
    HIVE_HIJACK_MARKER: hijackMarker,
    HOME: home,
    PATH: `${localBin}:${bin}:/usr/bin:/bin`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(hijackMarker), false);
  assert.equal(readFileSync(binaryTarget, "utf8"), "preserve candidate binary\n");
  assert.equal(readFileSync(markerTarget, "utf8"), "preserve candidate version\n");
  assert.equal(statSync(binaryTarget).mode & 0o777, 0o644);
  assert.equal(statSync(markerTarget).mode & 0o777, 0o644);
  assert.equal(lstatSync(binary).isSymbolicLink(), false);
  assert.equal(lstatSync(versionMarker).isSymbolicLink(), false);
  assert.equal(statSync(binary).mode & 0o777, 0o755);
  assert.equal(statSync(versionMarker).mode & 0o777, 0o600);
  assert.equal(readFileSync(versionMarker, "utf8"), "2.63.18\n");
});

test("File Browser rejects a linked database without touching its target", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-filebrowser-database-"));
  const home = join(root, "home");
  const databaseDirectory = join(home, ".config", "filebrowser");
  const database = join(databaseDirectory, "filebrowser.db");
  const candidateDatabase = join(root, "candidate.db");
  const renderedToolsFilebrowser = join(root, "rendered-tools-filebrowser.sh");
  mkdirSync(databaseDirectory, { recursive: true });
  writeFileSync(candidateDatabase, "preserve candidate database\n");
  chmodSync(candidateDatabase, 0o640);
  symlinkSync(candidateDatabase, database);
  writeFileSync(
    renderedToolsFilebrowser,
    renderToolsFilebrowserScript("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
  );

  const result = run("bash", [renderedToolsFilebrowser], {
    ...process.env,
    HOME: home,
    PATH: "/usr/bin:/bin",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unsafe File Browser database was preserved/);
  assert.equal(lstatSync(database).isSymbolicLink(), true);
  assert.equal(readFileSync(candidateDatabase, "utf8"), "preserve candidate database\n");
  assert.equal(statSync(candidateDatabase).mode & 0o777, 0o640);
});

test("init atomically replaces linked MCP configs without touching their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-init-mcp-links-"));
  const home = join(root, "home");
  const codexConfig = join(home, ".codex", "config.toml");
  const claudeConfig = join(home, ".claude", "mcp.json");
  const codexTarget = join(root, "candidate-codex-config");
  const claudeTarget = join(root, "candidate-claude-config");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(codexTarget, 'model = "candidate-owned"\n');
  writeFileSync(claudeTarget, '{"mcpServers":{"candidate":{"command":"keep"}}}\n');
  chmodSync(codexTarget, 0o644);
  chmodSync(claudeTarget, 0o644);
  symlinkSync(codexTarget, codexConfig);
  symlinkSync(claudeTarget, claudeConfig);

  const result = runInit(root, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(codexTarget, "utf8"), 'model = "candidate-owned"\n');
  assert.equal(
    readFileSync(claudeTarget, "utf8"),
    '{"mcpServers":{"candidate":{"command":"keep"}}}\n',
  );
  assert.equal(statSync(codexTarget).mode & 0o777, 0o644);
  assert.equal(statSync(claudeTarget).mode & 0o777, 0o644);
  assert.equal(lstatSync(codexConfig).isSymbolicLink(), false);
  assert.equal(lstatSync(claudeConfig).isSymbolicLink(), false);
  assert.equal(statSync(codexConfig).mode & 0o777, 0o600);
  assert.equal(statSync(claudeConfig).mode & 0o777, 0o600);
  assert.match(readFileSync(codexConfig, "utf8"), /mcp_servers\.hive_playwright/);
  assert.equal(
    JSON.parse(readFileSync(claudeConfig, "utf8")).mcpServers.hive_playwright.command.endsWith(
      "playwright-mcp",
    ),
    true,
  );
});

test("init preserves non-regular MCP paths and defers them to readiness", () => {
  const fixture = createFixture();
  const codexConfig = join(fixture.home, ".codex", "config.toml");
  const claudeConfig = join(fixture.home, ".claude", "mcp.json");
  const sharedConfig = join(fixture.home, ".mcp.json");
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(codexConfig);
  mkdirSync(sharedConfig);
  const fifo = run("/usr/bin/mkfifo", [claudeConfig], process.env);
  assert.equal(fifo.status, 0, fifo.stderr);

  const init = runInit(fixture.root, fixture.home);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stderr, /preserving non-regular Codex MCP config/);
  assert.match(init.stderr, /preserving non-regular MCP config/);
  assert.equal(lstatSync(codexConfig).isDirectory(), true);
  assert.equal(lstatSync(claudeConfig).isFIFO(), true);
  assert.equal(lstatSync(sharedConfig).isDirectory(), true);

  installHelpers(fixture);
  const check = run(join(fixture.home, ".local", "bin", "interview-check"), [], fixture.env);
  assert.equal(check.status, 1);
  assert.match(
    `${check.stdout}\n${check.stderr}`,
    /\[FAIL\] managed Playwright MCP configuration is ready/,
  );
});

test("init rejects linked MCP configuration directories without touching their targets", () => {
  const fixture = createFixture();
  const codexTarget = join(fixture.root, "candidate-codex-directory");
  const claudeTarget = join(fixture.root, "candidate-claude-directory");
  mkdirSync(codexTarget);
  mkdirSync(claudeTarget);
  writeFileSync(join(codexTarget, "candidate.txt"), "preserve codex directory\n");
  writeFileSync(join(claudeTarget, "candidate.txt"), "preserve claude directory\n");
  symlinkSync(codexTarget, join(fixture.home, ".codex"));
  symlinkSync(claudeTarget, join(fixture.home, ".claude"));

  const init = runInit(fixture.root, fixture.home);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stderr, /unsafe Codex configuration directory/);
  assert.match(init.stderr, /unsafe MCP configuration directory/);
  assert.equal(lstatSync(join(fixture.home, ".codex")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(fixture.home, ".claude")).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(codexTarget), ["candidate.txt"]);
  assert.deepEqual(readdirSync(claudeTarget), ["candidate.txt"]);

  installHelpers(fixture);
  const check = run(join(fixture.home, ".local", "bin", "interview-check"), [], fixture.env);
  assert.equal(check.status, 1);
  assert.match(
    `${check.stdout}\n${check.stderr}`,
    /\[FAIL\] managed Playwright MCP configuration is ready/,
  );
});

test("init preserves MCP configs whose JSON containers are not objects", () => {
  const fixture = createFixture();
  const claudeConfig = join(fixture.home, ".claude", "mcp.json");
  const sharedConfig = join(fixture.home, ".mcp.json");
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  writeFileSync(claudeConfig, "[]\n");
  writeFileSync(sharedConfig, '{"mcpServers":[]}\n');

  const result = runInit(fixture.root, fixture.home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /non-object root/);
  assert.match(result.stdout, /non-object mcpServers/);
  assert.equal(readFileSync(claudeConfig, "utf8"), "[]\n");
  assert.equal(readFileSync(sharedConfig, "utf8"), '{"mcpServers":[]}\n');

  installHelpers(fixture);
  const readiness = run(
    "bash",
    [
      "-c",
      'source "$HOME/.local/libexec/hive/technical-interview/common.sh"; interview_mcp_configuration_ready',
    ],
    fixture.env,
  );
  assert.equal(readiness.status, 1, "invalid JSON MCP containers must fail readiness");
});

test("linked shell configuration is preserved and fails the strict scrub check", () => {
  const fixture = createFixture();
  const linkedShell = join(fixture.home, ".bash_profile");
  const candidateFile = join(fixture.root, "candidate-shell-config");
  writeFileSync(candidateFile, "preserve linked shell configuration\n");
  symlinkSync(candidateFile, linkedShell);

  const init = runInit(fixture.root, fixture.home);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stderr, /linked shell configuration bypasses credential scrubbing/);
  assert.equal(readFileSync(candidateFile, "utf8"), "preserve linked shell configuration\n");
  assert.equal(lstatSync(linkedShell).isSymbolicLink(), true);

  installHelpers(fixture);
  const check = run(join(fixture.home, ".local", "bin", "interview-check"), [], fixture.env);
  assert.equal(check.status, 1);
  assert.match(
    `${check.stdout}\n${check.stderr}`,
    /\[FAIL\] interactive shell credential scrub hooks are installed/,
  );
});

test("repository bootstrap clones anonymously and preserves an existing checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "technical-interview-clone-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const manifest = join(root, "repositories.txt");
  const calls = join(root, "git-calls.log");
  const destination = join(home, "projects", "prmsolutions", "interview-template");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(manifest, "prmsolutions/interview-template|prmsolutions/interview-template\n");
  executable(
    join(bin, "git"),
    `#!/bin/bash
set -euo pipefail
[ "$1" = "-c" ]
[ "$2" = "credential.helper=" ]
[ "$3" = "clone" ]
[ "$4" = "https://github.com/prmsolutions/interview-template.git" ]
[ "$HOME" != "$ORIGINAL_HOME" ]
[ "$GIT_CONFIG_GLOBAL" = "/dev/null" ]
[ "$GIT_CONFIG_NOSYSTEM" = "1" ]
[ "$GIT_ASKPASS" = "/bin/false" ]
[ "$GIT_SSH_COMMAND" = "/bin/false" ]
[ "$SSH_ASKPASS" = "/bin/false" ]
[ -z "\${ANTHROPIC_API_KEY:-}" ]
${claudeCredentialAssertions}
[ -z "\${GH_TOKEN:-}" ]
[ -z "\${GITHUB_TOKEN:-}" ]
[ -z "\${CODER_AGENT_TOKEN:-}" ]
[ -z "\${CODER_SESSION_TOKEN:-}" ]
[ -z "\${REALM_VISUAL_REVIEW_API_KEY:-}" ]
[ -z "\${RUNCOMFY_API_TOKEN:-}" ]
[ -z "\${GIT_CONFIG:-}" ]
[ -z "\${GIT_CONFIG_COUNT:-}" ]
[ -z "\${GIT_CONFIG_PARAMETERS:-}" ]
[ -z "\${SSH_AUTH_SOCK:-}" ]
[ -z "\${SSH_AGENT_PID:-}" ]
mkdir -p "$5/.git"
printf '%s\\n' "$*" >> "$GIT_CALLS"
`,
  );

  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "must-not-reach-git",
    ANTHROPIC_AUTH_TOKEN: "must-not-reach-git",
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "must-not-reach-git",
    CLAUDE_CODE_OAUTH_SCOPES: "must-not-reach-git",
    CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-git",
    CODER_AGENT_TOKEN: "must-not-reach-git",
    CODER_SESSION_TOKEN: "must-not-reach-git",
    GIT_ASKPASS: "must-not-reach-git",
    GH_TOKEN: "must-not-reach-git",
    GITHUB_TOKEN: "must-not-reach-git",
    GIT_CONFIG: join(root, "personal-git-config"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_PARAMETERS: "'url.ssh://personal/.insteadOf=https://github.com/'",
    GIT_CONFIG_VALUE_0: "Authorization: must-not-reach-git",
    GIT_SSH_COMMAND: "must-not-reach-git",
    GIT_CALLS: calls,
    HOME: home,
    ORIGINAL_HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    REALM_VISUAL_REVIEW_API_KEY: "must-not-reach-git",
    REPOSITORIES_FILE: manifest,
    RUNCOMFY_API_TOKEN: "must-not-reach-git",
    SSH_AGENT_PID: "4242",
    SSH_ASKPASS: "must-not-reach-git",
    SSH_AUTH_SOCK: join(root, "personal-agent.sock"),
  };
  const first = run("bash", [cloneScript], env);
  assert.equal(first.status, 0, first.stderr);
  const firstCalls = readFileSync(calls, "utf8");
  assert.match(firstCalls, /clone https:\/\/github\.com\/prmsolutions\/interview-template\.git/);
  assert.doesNotMatch(firstCalls, /must-not-reach/);

  const candidateFile = join(destination, "candidate-work.txt");
  writeFileSync(candidateFile, "preserve me\n");
  const second = run("bash", [cloneScript], env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /preserving existing interview repository/);
  assert.equal(readFileSync(candidateFile, "utf8"), "preserve me\n");
  assert.equal(readFileSync(calls, "utf8"), firstCalls);
});

test("remote default checks isolate Git configuration and SSH credentials", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const result = run(
    "bash",
    [
      "-c",
      'source "$HOME/.local/libexec/hive/technical-interview/common.sh"; interview_anonymous_git ls-remote "$INTERVIEW_EXPECTED_ORIGIN" HEAD',
    ],
    {
      ...fixture.env,
      GIT_ASKPASS: "must-not-reach-git",
      GIT_CONFIG: join(fixture.root, "personal-git-config"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_PARAMETERS: "'url.ssh://personal/.insteadOf=https://github.com/'",
      GIT_CONFIG_VALUE_0: "Authorization: must-not-reach-git",
      GIT_SSH_COMMAND: "must-not-reach-git",
      SSH_AGENT_PID: "4242",
      SSH_ASKPASS: "must-not-reach-git",
      SSH_AUTH_SOCK: join(fixture.root, "personal-agent.sock"),
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${fixture.commit}\tHEAD`);
});

test("bootstrap installs executable helper commands idempotently", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const expectedHelpers = [
    "interview-check",
    "interview-claude",
    "interview-restart",
    "interview-setup",
    "interview-start",
    "interview-status",
    "interview-stop",
  ];
  const firstContents = new Map();
  for (const helper of expectedHelpers) {
    const path = join(fixture.home, ".local", "bin", helper);
    assert.equal(existsSync(path), true, `${helper} must be generated`);
    assert.equal(statSync(path).mode & 0o777, 0o700);
    firstContents.set(helper, readFileSync(path, "utf8"));
  }

  installHelpers(fixture);
  for (const helper of expectedHelpers) {
    const path = join(fixture.home, ".local", "bin", helper);
    assert.equal(readFileSync(path, "utf8"), firstContents.get(helper));
  }
  for (const helper of ["interview-start", "interview-restart"]) {
    const contents = firstContents.get(helper);
    assert.match(contents, /--host 127\.0\.0\.1/);
    assert.doesNotMatch(contents, /--host 0\.0\.0\.0/);
  }
  assert.doesNotMatch(
    readFileSync(join(fixture.home, ".local", "bin", "interview-claude"), "utf8"),
    /use-env-key/,
  );
});

test("fresh bootstrap installs the pinned standalone toolchain idempotently", () => {
  const fixture = createFixture();
  installHelpers(fixture);

  const expectedTools = new Map([
    ["codex", "codex-cli 0.149.1"],
    ["playwright-mcp", "Version 0.0.79"],
    ["bun", "1.4.0"],
    ["pnpm", "10.32.1"],
  ]);
  for (const [command, version] of expectedTools) {
    const commandPath = join(fixture.home, ".local", "bin", command);
    assert.equal(existsSync(commandPath), true, `${command} must be installed for a fresh home`);
    const result = run(commandPath, ["--version"], fixture.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(version.replaceAll(".", "\\.")));
  }

  const firstCalls = readFileSync(fixture.calls, "utf8");
  for (const packageName of [
    "@openai/codex@0.149.1",
    "@playwright/mcp@0.0.79",
    "@oven/bun-linux-x64@1.4.0",
    "pnpm@10.32.1",
  ]) {
    assert.equal(
      firstCalls.split(`tool-install:${packageName}\n`).length - 1,
      1,
      `${packageName} must be installed exactly once`,
    );
  }

  installHelpers(fixture);
  assert.equal(readFileSync(fixture.calls, "utf8"), firstCalls);
});

test("bootstrap reuses exact pinned tools from the Hive image baseline", () => {
  const fixture = createFixture();
  const localBin = join(fixture.home, ".local", "bin");
  const baselineCodex = join(
    fixture.home,
    ".local",
    "lib",
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  const baselineBun = join(fixture.home, ".bun", "bin", "bun");
  mkdirSync(localBin, { recursive: true });
  mkdirSync(join(baselineCodex, ".."), { recursive: true });
  mkdirSync(join(baselineBun, ".."), { recursive: true });
  executable(baselineCodex, "#!/bin/sh\nprintf 'codex-cli 0.149.1\\n'\n");
  executable(baselineBun, "#!/bin/sh\nprintf '1.4.0\\n'\n");
  symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", join(localBin, "codex"));
  symlinkSync(baselineBun, join(localBin, "bun"));

  installHelpers(fixture);

  const calls = readFileSync(fixture.calls, "utf8");
  assert.doesNotMatch(calls, /tool-install:@openai\/codex/);
  assert.doesNotMatch(calls, /tool-install:@oven\/bun-linux-x64/);
  const ready = run(
    "bash",
    [
      "-c",
      'source "$HOME/.local/libexec/hive/technical-interview/common.sh"; interview_managed_tool_ready codex "$INTERVIEW_CODEX_VERSION" .bin/codex "$INTERVIEW_CODEX_BASELINE_TARGET" && interview_managed_tool_ready bun "$INTERVIEW_BUN_VERSION" @oven/bun-linux-x64/bin/bun "$INTERVIEW_BUN_BASELINE_TARGET"',
    ],
    fixture.env,
  );
  assert.equal(ready.status, 0, ready.stderr);
});

test("bootstrap replaces stale Hive-managed tools with the pinned versions", () => {
  const fixture = createFixture();
  const localBin = join(fixture.home, ".local", "bin");
  const staleCodex = join(
    fixture.home,
    ".local",
    "state",
    "hive",
    "technical-interview",
    "tools",
    "codex-0.100.0",
    "node_modules",
    ".bin",
    "codex",
  );
  mkdirSync(localBin, { recursive: true });
  mkdirSync(join(staleCodex, ".."), { recursive: true });
  executable(staleCodex, "#!/bin/sh\nprintf 'codex-cli 0.100.0\\n'\n");
  symlinkSync(staleCodex, join(localBin, "codex"));

  installHelpers(fixture);

  const result = run(join(localBin, "codex"), ["--version"], fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "codex-cli 0.149.1");
  assert.match(readFileSync(fixture.calls, "utf8"), /tool-install:@openai\/codex@0\.149\.1/);
});

test("bootstrap preserves unexpected user tools as an explicit readiness failure", () => {
  const fixture = createFixture();
  const localBin = join(fixture.home, ".local", "bin");
  const userPnpm = join(localBin, "pnpm");
  mkdirSync(localBin, { recursive: true });
  executable(userPnpm, "#!/bin/sh\nprintf '10.32.1\\n'\n");

  const install = installHelpers(fixture);
  assert.match(install.stderr, /Preserving unexpected pnpm command/);
  assert.equal(readFileSync(userPnpm, "utf8"), "#!/bin/sh\nprintf '10.32.1\\n'\n");

  const ready = run(
    "bash",
    [
      "-c",
      'source "$HOME/.local/libexec/hive/technical-interview/common.sh"; interview_managed_tool_ready pnpm "$INTERVIEW_PNPM_VERSION" .bin/pnpm',
    ],
    fixture.env,
  );
  assert.notEqual(ready.status, 0);
});

test("setup repairs and reuses an incomplete pinned virtualenv fallback", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const fallbackRoot = join(
    fixture.home,
    ".local",
    "state",
    "hive",
    "technical-interview",
    "virtualenv-20.35.4",
  );
  const backendVenv = join(fixture.interviewRepository, "backend", ".venv");
  const setup = join(fixture.home, ".local", "bin", "interview-setup");
  mkdirSync(join(fallbackRoot, "virtualenv"), { recursive: true });
  writeFileSync(join(fallbackRoot, "virtualenv", "__main__.py"), "# incomplete install\n");
  writeFileSync(join(fallbackRoot, "stale-partial-install"), "must be replaced\n");

  const fallbackEnvironment = {
    ...fixture.env,
    FAKE_STANDARD_VENV_FAIL: "1",
  };
  const first = run(setup, [], fallbackEnvironment);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(existsSync(join(fallbackRoot, ".hive-fixture-complete")), true);
  assert.equal(existsSync(join(fallbackRoot, "stale-partial-install")), false);
  assert.equal(
    (readFileSync(fixture.calls, "utf8").match(/virtualenv-fallback-install/g) ?? []).length,
    1,
  );

  rmSync(backendVenv, { recursive: true });
  const second = run(setup, [], fallbackEnvironment);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    (readFileSync(fixture.calls, "utf8").match(/virtualenv-fallback-install/g) ?? []).length,
    1,
  );
});

test("setup hashes dependencies, reinstalls only on manifest changes, and preserves dirty work", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const setup = join(fixture.home, ".local", "bin", "interview-setup");

  const first = run(setup, [], fixture.env);
  assert.equal(first.status, 0, first.stderr);
  const firstCalls = readFileSync(fixture.calls, "utf8");
  assert.equal((firstCalls.match(/pip-install/g) ?? []).length, 1);
  assert.equal((firstCalls.match(/npm-install/g) ?? []).length, 1);
  assert.equal(
    existsSync(join(fixture.interviewRepository, "frontend", "package-lock.json")),
    false,
  );

  const second = run(setup, [], fixture.env);
  assert.equal(second.status, 0, second.stderr);
  const secondCalls = readFileSync(fixture.calls, "utf8");
  assert.equal((secondCalls.match(/pip-install/g) ?? []).length, 1);
  assert.equal((secondCalls.match(/npm-install/g) ?? []).length, 1);

  const staleEnvironmentFile = join(
    fixture.interviewRepository,
    "backend",
    ".venv",
    "stale-package-from-old-manifest",
  );
  writeFileSync(staleEnvironmentFile, "must be removed with the old environment\n");
  const candidateFile = join(fixture.interviewRepository, "candidate-work.txt");
  writeFileSync(candidateFile, "do not overwrite\n");
  writeFileSync(
    join(fixture.interviewRepository, "backend", "requirements.txt"),
    "fastapi>=0.115.0\npytest>=8.0.0\n# candidate dependency change\n",
  );
  const changed = run(setup, [], fixture.env);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(existsSync(staleEnvironmentFile), false);
  assert.match(changed.stdout, /Recreating the managed backend virtual environment/);
  assert.equal(readFileSync(candidateFile, "utf8"), "do not overwrite\n");
  assert.match(changed.stderr, /preserving them unchanged/);
  const changedCalls = readFileSync(fixture.calls, "utf8");
  assert.equal((changedCalls.match(/pip-install/g) ?? []).length, 2);
  assert.equal((changedCalls.match(/npm-install/g) ?? []).length, 1);
});

test("setup refreshes frontend dependencies when the Node runtime ABI changes", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const setup = join(fixture.home, ".local", "bin", "interview-setup");

  const first = run(setup, [], fixture.env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal((readFileSync(fixture.calls, "utf8").match(/npm-install/g) ?? []).length, 1);

  const changedRuntime = { ...fixture.env, FAKE_NODE_ABI: "999" };
  const changed = run(setup, [], changedRuntime);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal((readFileSync(fixture.calls, "utf8").match(/npm-install/g) ?? []).length, 2);

  const unchanged = run(setup, [], changedRuntime);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal((readFileSync(fixture.calls, "utf8").match(/npm-install/g) ?? []).length, 2);
});

test("setup repairs an incomplete frontend dependency tree with a current hash", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const setup = join(fixture.home, ".local", "bin", "interview-setup");

  const first = run(setup, [], fixture.env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal((readFileSync(fixture.calls, "utf8").match(/npm-install/g) ?? []).length, 1);

  const incompleteMarker = join(
    fixture.interviewRepository,
    "frontend",
    "node_modules",
    ".hive-fixture-incomplete",
  );
  writeFileSync(incompleteMarker, "simulate an interrupted dependency installation\n");
  const repaired = run(setup, [], fixture.env);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Installing frontend dependencies/);
  assert.equal(existsSync(incompleteMarker), false);
  assert.equal((readFileSync(fixture.calls, "utf8").match(/npm-install/g) ?? []).length, 2);

  const unchanged = run(setup, [], fixture.env);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal((readFileSync(fixture.calls, "utf8").match(/npm-install/g) ?? []).length, 2);
});

test("setup recreates the backend environment when the Python runtime ABI changes", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const setup = join(fixture.home, ".local", "bin", "interview-setup");

  const first = run(setup, [], fixture.env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal((readFileSync(fixture.calls, "utf8").match(/pip-install/g) ?? []).length, 1);

  const staleEnvironmentFile = join(
    fixture.interviewRepository,
    "backend",
    ".venv",
    "old-python-runtime",
  );
  writeFileSync(staleEnvironmentFile, "must be removed with the old Python environment\n");
  const changedRuntime = {
    ...fixture.env,
    FAKE_PYTHON_RUNTIME: "3.14.0|cache:cpython-314|abi:cpython-314-x86_64-linux-gnu",
  };
  const changed = run(setup, [], changedRuntime);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(existsSync(staleEnvironmentFile), false);
  assert.match(changed.stdout, /Recreating the managed backend virtual environment/);
  assert.equal((readFileSync(fixture.calls, "utf8").match(/pip-install/g) ?? []).length, 2);

  const unchanged = run(setup, [], changedRuntime);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal((readFileSync(fixture.calls, "utf8").match(/pip-install/g) ?? []).length, 2);
});

test("setup restarts only active service windows after dependency refresh", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const setup = join(fixture.home, ".local", "bin", "interview-setup");
  const start = join(fixture.home, ".local", "bin", "interview-start");

  assert.equal(run(setup, [], fixture.env).status, 0);
  const started = run(start, [], fixture.env);
  assert.equal(started.status, 0, started.stderr);
  const callsBeforeRefresh = readFileSync(fixture.calls, "utf8");
  for (const credentialName of [
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
  ]) {
    assert.match(callsBeforeRefresh, new RegExp(`-u ${credentialName}`));
  }

  writeFileSync(
    join(fixture.interviewRepository, "backend", "requirements.txt"),
    "fastapi>=0.115.0\npytest>=8.0.0\n# refresh active services\n",
  );
  const refreshed = run(setup, [], fixture.env);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.match(refreshed.stdout, /restarting only the API and frontend service windows/);
  const refreshCalls = readFileSync(fixture.calls, "utf8").slice(callsBeforeRefresh.length);
  assert.match(refreshCalls, /tmux:respawn-window -k -t interview:api/);
  assert.match(refreshCalls, /tmux:respawn-window -k -t interview:web/);
  assert.doesNotMatch(refreshCalls, /tmux:respawn-window[^\n]+interview:(?:work|ai)/);
});

test("GitHub auth detection rejects any valid account and accepts a missing CLI", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const common = join(
    fixture.home,
    ".local",
    "libexec",
    "hive",
    "technical-interview",
    "common.sh",
  );
  const mixedAccounts = JSON.stringify({
    hosts: {
      "github.com": [
        { active: true, login: "valid", state: "success" },
        { active: false, login: "stale", state: "failure" },
      ],
    },
  });
  const mixed = run(
    "bash",
    [
      "-c",
      `source "$HOME/.local/libexec/hive/technical-interview/common.sh"; interview_github_authenticated && ! interview_github_unauthenticated`,
    ],
    { ...fixture.env, FAKE_GH_AUTH_JSON: mixedAccounts },
  );
  assert.equal(mixed.status, 0, mixed.stderr);

  const staleOnly = JSON.stringify({
    hosts: { "github.com": [{ active: true, login: "stale", state: "failure" }] },
  });
  const unauthenticated = run(
    "bash",
    [
      "-c",
      `source "${common}"; ! interview_github_authenticated && interview_github_unauthenticated`,
    ],
    { ...fixture.env, FAKE_GH_AUTH_JSON: staleOnly },
  );
  assert.equal(unauthenticated.status, 0, unauthenticated.stderr);

  unlinkSync(join(fixture.bin, "gh"));
  const missingCli = run(
    "bash",
    [
      "-c",
      `source "${common}"; ! interview_github_authenticated && interview_github_unauthenticated`,
    ],
    fixture.env,
  );
  assert.equal(missingCli.status, 0, missingCli.stderr);
});

test("Coder auth detection distinguishes confirmed absence from unknown failures", () => {
  const fixture = createFixture();
  installHelpers(fixture);
  const common = join(
    fixture.home,
    ".local",
    "libexec",
    "hive",
    "technical-interview",
    "common.sh",
  );
  const authState = (state) =>
    run("bash", ["-c", `source "${common}"; interview_coder_auth_state`], {
      ...fixture.env,
      FAKE_CODER_AUTH_STATE: state,
    });

  assert.equal(authState("authenticated").stdout.trim(), "authenticated");
  assert.equal(authState("unauthenticated").stdout.trim(), "unauthenticated");
  assert.equal(authState("unavailable").stdout.trim(), "unknown");
  assert.equal(authState("timeout").stdout.trim(), "unknown");

  const status = run(join(fixture.home, ".local", "bin", "interview-status"), [], {
    ...fixture.env,
    FAKE_CODER_AUTH_STATE: "unavailable",
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Coder orchestration authentication: UNKNOWN \(readiness fails\)/);

  unlinkSync(join(fixture.bin, "coder"));
  const missingCli = run(
    "bash",
    ["-c", `source "${common}"; interview_coder_auth_state`],
    fixture.env,
  );
  assert.equal(missingCli.status, 0, missingCli.stderr);
  assert.equal(missingCli.stdout.trim(), "unauthenticated");
});

test("readiness reports strict success and failure without network cloning", () => {
  const fixture = createFixture();
  const init = runInit(fixture.root, fixture.home);
  assert.equal(init.status, 0, init.stderr);
  installHelpers(fixture);
  const setup = join(fixture.home, ".local", "bin", "interview-setup");
  const start = join(fixture.home, ".local", "bin", "interview-start");
  const check = join(fixture.home, ".local", "bin", "interview-check");
  try {
    assert.equal(run(setup, [], fixture.env).status, 0);
    const startResult = run(start, [], fixture.env);
    assert.equal(startResult.status, 0, startResult.stderr);
    const ready = run(check, [], fixture.env);
    assert.equal(ready.status, 0, ready.stderr);
    assert.match(ready.stdout, /INTERVIEW WORKSPACE READY/);
    assert.match(
      readFileSync(join(fixture.home, "INTERVIEW_READY.md"), "utf8"),
      /INTERVIEW WORKSPACE READY/,
    );
    assert.match(ready.stdout, /Codex 0\.149\.1 is pinned/);
    assert.match(ready.stdout, /Playwright MCP 0\.0\.79 is pinned/);
    assert.match(ready.stdout, /Bun 1\.4\.0 is pinned/);
    assert.match(ready.stdout, /pnpm 10\.32\.1 is pinned/);

    const unknownCoderAuth = run(check, [], {
      ...fixture.env,
      FAKE_CODER_AUTH_STATE: "unavailable",
    });
    assert.equal(unknownCoderAuth.status, 1);
    assert.match(
      `${unknownCoderAuth.stdout}\n${unknownCoderAuth.stderr}`,
      /\[FAIL\] Coder CLI is not authenticated for orchestration/,
    );

    const failed = run(check, [], { ...fixture.env, FAKE_PYTEST_FAIL: "1" });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /INTERVIEW WORKSPACE NOT READY/);
    assert.match(
      readFileSync(join(fixture.home, "INTERVIEW_READY.md"), "utf8"),
      /INTERVIEW WORKSPACE NOT READY/,
    );
  } finally {
    stopTmux(fixture);
  }
});

test("interview-claude masks and scopes the temporary key without persisting it", async (t) => {
  if (!existsSync("/usr/bin/script")) {
    t.skip("util-linux script command is unavailable");
    return;
  }
  const fixture = createFixture();
  installHelpers(fixture);
  const helper = join(fixture.home, ".local", "bin", "interview-claude");
  const fakeKey = "temporary-interview-key-should-never-persist";
  const command = `${helper} --model test-model -- 'argument with spaces'`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/script", ["-qefc", command, "/dev/null"], {
      env: {
        ...fixture.env,
        ANTHROPIC_API_KEY: "inherited-key-must-be-overridden",
        CODER_AGENT_TOKEN: "must-not-reach-claude",
        CODER_SESSION_TOKEN: "must-not-reach-claude",
        EXPECTED_CLAUDE_KEY: fakeKey,
        GH_TOKEN: "must-not-reach-claude",
        GITHUB_TOKEN: "must-not-reach-claude",
        REALM_VISUAL_REVIEW_API_KEY: "must-not-reach-claude",
        RUNCOMFY_API_TOKEN: "must-not-reach-claude",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let keySent = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("masked Claude prompt timed out"));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!keySent && stdout.includes("Temporary Anthropic API key:")) {
        keySent = true;
        child.stdin.write(`${fakeKey}\n`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stderr, stdout });
    });
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(fakeKey));
  assert.doesNotMatch(result.stderr, new RegExp(fakeKey));
  assert.equal(
    readFileSync(fixture.claudeArgs, "utf8"),
    "<--model>\n<test-model>\n<argument with spaces>\n",
  );
  for (const path of filesRecursively(fixture.home)) {
    assert.equal(
      readFileSync(path).includes(Buffer.from(fakeKey)),
      false,
      `temporary key leaked into ${path}`,
    );
  }
});
