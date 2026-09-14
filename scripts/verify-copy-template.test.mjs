import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const templateRoot = join(process.cwd(), "templates/copy-dev");
const setup = join(templateRoot, "project/setup.sh");

function fixture(t, { lockfile = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "copy-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home with spaces");
  const project = join(home, "projects/lunarresearcher/copy");
  const bin = join(root, "bin");
  const calls = join(root, "npm-calls");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(project, "bin"));
  mkdirSync(join(project, "data"));
  mkdirSync(bin);
  writeFileSync(join(project, "package.json"), '{"name":"copy-fixture","version":"1.0.0"}\n');
  writeFileSync(join(project, ".env.example"), "PORT=8787\nNATIVE_EXECUTOR_WEBHOOK=\n");
  writeFileSync(
    join(project, "bin/copy.mjs"),
    "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n",
  );
  if (lockfile) writeFileSync(join(project, "package-lock.json"), "{}\n");
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/bash
set -eu
if [ "$1" = --version ]; then echo 10.0.0; exit; fi
printf '%s\\n' "$*" >> "$NPM_CALLS"
[ "\${FAIL_INSTALL:-0}" != 1 ]
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NPM_CALLS: calls };
  return {
    home,
    project,
    calls,
    env,
    run: (extra = {}) =>
      spawnSync("bash", [setup], { env: { ...env, ...extra }, encoding: "utf8" }),
  };
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("fresh COPY setup creates private config and a launcher that preserves cwd and arguments", (t) => {
  const f = fixture(t);
  assertSuccess(f.run());
  assert.equal(statSync(join(f.project, ".env")).mode & 0o777, 0o600);
  assert.equal(
    readFileSync(join(f.project, ".env"), "utf8"),
    "PORT=8787\nNATIVE_EXECUTOR_WEBHOOK=\n",
  );
  assert.equal(existsSync(join(f.project, "package-lock.json")), false);
  assert.equal(
    readFileSync(f.calls, "utf8"),
    "install --ignore-scripts --no-audit --no-fund --package-lock=false\n",
  );
  const result = spawnSync(join(f.home, ".local/bin/copy"), ["scan", "a token", "$(literal)"], {
    cwd: f.home,
    env: f.env,
    encoding: "utf8",
  });
  assertSuccess(result);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: f.project,
    args: ["scan", "a token", "$(literal)"],
  });
});

test("restart preserves credentials, paper state, cache, and repository edits without reinstalling", (t) => {
  const f = fixture(t);
  assertSuccess(f.run());
  const files = {
    ".env": "REPLYNODES_API_KEY=private-fixture\n",
    "data/runtime.json": '{"positions":[{"id":"paper-1"}]}\n',
    "data/cache.json": '{"queue":["saved"]}\n',
    "bin/copy.mjs": "// local unfinished work\n",
  };
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(f.project, path), content);
  assertSuccess(f.run());
  for (const [path, content] of Object.entries(files)) {
    assert.equal(readFileSync(join(f.project, path), "utf8"), content);
  }
  assert.equal(readFileSync(f.calls, "utf8").trim().split("\n").length, 1);
});

test("dependency changes and removed modules trigger reinstall; a failed install is retried", (t) => {
  const f = fixture(t, { lockfile: true });
  assertSuccess(f.run());
  writeFileSync(join(f.project, "package-lock.json"), '{"lockfileVersion":3}\n');
  assert.equal(f.run({ FAIL_INSTALL: "1" }).status, 1);
  assertSuccess(f.run());
  rmSync(join(f.project, "node_modules"), { recursive: true });
  assertSuccess(f.run());
  assert.deepEqual(readFileSync(f.calls, "utf8").trim().split("\n"), [
    "ci --ignore-scripts --no-audit --no-fund",
    "ci --ignore-scripts --no-audit --no-fund",
    "ci --ignore-scripts --no-audit --no-fund",
    "ci --ignore-scripts --no-audit --no-fund",
  ]);
});

test("a failed clone reports recovery instructions without installing into an incomplete checkout", (t) => {
  const f = fixture(t);
  rmSync(join(f.project, ".git"), { recursive: true });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checkout is missing.*clone-repositories\.sh/);
  assert.equal(existsSync(f.calls), false);
  assert.equal(existsSync(join(f.project, ".env")), false);
});

test("COPY app stays private and manual, and project setup runs after cloning", () => {
  const terraform = readFileSync(join(templateRoot, "main.tf"), "utf8");
  const ci = readFileSync(join(templateRoot, "scripts/tools-ci.sh"), "utf8");
  const app = readFileSync(join(templateRoot, "project.tf"), "utf8");
  const workflow = readFileSync(
    join(process.cwd(), ".github/workflows/build-base-image.yml"),
    "utf8",
  );
  assert.match(terraform, /project_setup_script_b64\s*=\s*fileexists\(local\.project_setup_path\)/);
  const cloneIndex = ci.indexOf('"$HOME/clone-repositories.sh"\n');
  const setupIndex = ci.indexOf('"$HOME/.local/libexec/hive-project-setup"\n');
  assert.ok(cloneIndex >= 0 && setupIndex > cloneIndex);
  assert.match(app, /share\s*=\s*"owner"/);
  assert.match(app, /subdomain\s*=\s*true/);
  assert.match(app, /url\s*=\s*"http:\/\/localhost:8787"/);
  assert.doesNotMatch(app, /healthcheck\s*\{/);
  assert.match(workflow, /cli_profiles=\([\s\S]*?templates\/copy-dev\/profile\.json[\s\S]*?\)/);
});
