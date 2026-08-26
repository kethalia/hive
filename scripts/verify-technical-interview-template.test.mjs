/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are isolated under mkdtemp fixtures. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const templateRoot = join(repositoryRoot, "templates", "technical-interview");
const bootstrapScript = join(templateRoot, "bootstrap.sh");
const cloneScript = join(templateRoot, "scripts", "clone-repositories.sh");
const expectedOrigin = "https://github.com/prmsolutions/interview-template.git";

function executable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function git(...args) {
  const result = spawnSync("/usr/bin/git", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
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
if [ "\${1:-}" = "--version" ]; then printf 'Python 3.13.5\\n'; exit 0; fi
if [ "\${1:-}" = "-c" ]; then exit 0; fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "venv" ]; then
  target=$3
  mkdir -p "$target/bin"
  cat > "$target/bin/python" <<'PYTHON'
#!/bin/bash
set -euo pipefail
[ -z "\${CODER_AGENT_TOKEN:-}" ]
if [ "\${1:-}" = "--version" ]; then printf 'Python 3.13.5\\n'; exit 0; fi
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "pip" ]; then
  printf 'pip-install\\n' >> "$FAKE_CALLS"
fi
exit 0
PYTHON
  cat > "$target/bin/pytest" <<'PYTEST'
#!/bin/bash
[ -z "\${CODER_AGENT_TOKEN:-}" ]
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
printf 'unexpected python3 invocation: %s\\n' "$*" >&2
exit 2
`,
  );
  executable(
    join(bin, "node"),
    `#!/bin/bash
[ -z "\${CODER_AGENT_TOKEN:-}" ]
if [ "\${1:-}" = "--version" ]; then printf 'v24.19.0\\n'; fi
exit 0
`,
  );
  executable(
    join(bin, "npm"),
    `#!/bin/bash
set -euo pipefail
[ -z "\${CODER_AGENT_TOKEN:-}" ]
case "\${1:-}" in
  --version) printf '11.17.0\\n' ;;
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
for argument in "$@"; do
  if [ "$argument" = "ls-remote" ]; then
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
  executable(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  executable(join(bin, "coder"), "#!/bin/sh\nexit 1\n");

  const env = {
    ...process.env,
    CLAUDE_ARGS_LOG: claudeArgs,
    CODER_AGENT_TOKEN: "must-not-reach-child-processes",
    FAKE_CALLS: calls,
    FAKE_REMOTE_COMMIT: commit,
    FAKE_TMUX_STATE: tmuxRoot,
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
  const toolsCi = readFileSync(join(templateRoot, "scripts", "tools-ci.sh"), "utf8");
  const profile = JSON.parse(readFileSync(join(templateRoot, "profile.json"), "utf8"));

  assert.doesNotMatch(terraform, /coder_external_auth/);
  assert.doesNotMatch(terraform, /coder-login/);
  assert.doesNotMatch(terraform, /git-commit-signing|module "git-config"/);
  assert.doesNotMatch(terraform, /module "claude-code"/);
  assert.doesNotMatch(terraform, /WORKSPACE_ROUTING\.md/);
  assert.doesNotMatch(terraform, /scripts\/tools-ai\.sh/);
  assert.doesNotMatch(init, /command = "npx"|"command": "npx"/);
  assert.match(init, /\.local[^\n]+playwright-mcp/);
  assert.match(init, /"--browser", "chrome", "--no-sandbox", "--isolated"/);
  assert.match(init, /unset[^\n]+CODER_AGENT_TOKEN/);
  assert.match(toolsCi, /unset[^\n]+CODER_AGENT_TOKEN/);
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
[ -z "\${ANTHROPIC_API_KEY:-}" ]
[ -z "\${GH_TOKEN:-}" ]
[ -z "\${GITHUB_TOKEN:-}" ]
[ -z "\${CODER_AGENT_TOKEN:-}" ]
[ -z "\${CODER_SESSION_TOKEN:-}" ]
[ -z "\${REALM_VISUAL_REVIEW_API_KEY:-}" ]
[ -z "\${RUNCOMFY_API_TOKEN:-}" ]
mkdir -p "$5/.git"
printf '%s\\n' "$*" >> "$GIT_CALLS"
`,
  );

  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "must-not-reach-git",
    CODER_AGENT_TOKEN: "must-not-reach-git",
    CODER_SESSION_TOKEN: "must-not-reach-git",
    GH_TOKEN: "must-not-reach-git",
    GITHUB_TOKEN: "must-not-reach-git",
    GIT_CALLS: calls,
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    REALM_VISUAL_REVIEW_API_KEY: "must-not-reach-git",
    REPOSITORIES_FILE: manifest,
    RUNCOMFY_API_TOKEN: "must-not-reach-git",
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

  const candidateFile = join(fixture.interviewRepository, "candidate-work.txt");
  writeFileSync(candidateFile, "do not overwrite\n");
  writeFileSync(
    join(fixture.interviewRepository, "backend", "requirements.txt"),
    "fastapi>=0.115.0\npytest>=8.0.0\n# candidate dependency change\n",
  );
  const changed = run(setup, [], fixture.env);
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(readFileSync(candidateFile, "utf8"), "do not overwrite\n");
  assert.match(changed.stderr, /preserving them unchanged/);
  const changedCalls = readFileSync(fixture.calls, "utf8");
  assert.equal((changedCalls.match(/pip-install/g) ?? []).length, 2);
  assert.equal((changedCalls.match(/npm-install/g) ?? []).length, 1);
});

test("readiness reports strict success and failure without network cloning", () => {
  const fixture = createFixture();
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
