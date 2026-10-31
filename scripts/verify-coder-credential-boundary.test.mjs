import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const canonical = "templates/ai-dev-k8s";
const cleanup = readFileSync(`${canonical}/scripts/coder-credential-cleanup.py`, "utf8");
const entrypoint = readFileSync(`${canonical}/scripts/specialist-agent-entrypoint.sh`, "utf8");
const deployment = "https://coder.example.test";
const secret = "fixture-owner-secret-must-not-be-logged";
const encode = (value) => Buffer.from(value).toString("base64");

test("GitHub access tokens never enter rendered Coder startup metadata", () => {
  for (const name of [
    "ai-dev-k8s",
    "browser-testing",
    "game-dev",
    "electronics",
    "infrastructure",
  ]) {
    const root = `templates/${name}`;
    assert.doesNotMatch(
      readFileSync(`${root}/main.tf`, "utf8"),
      /data\.coder_external_auth\.[a-z_]+\.access_token/,
    );
    assert.doesNotMatch(readFileSync(`${root}/scripts/tools-ci.sh`, "utf8"), /\$\{github_token\}/);
  }
});

test("managed project startup skips bulk cloning and preserves the user's manifest and clones", (t) => {
  const home = mkdtempSync(join(tmpdir(), "hive-managed-bootstrap-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "repositories.txt"), "user/retained|user/retained\n");
  mkdirSync(join(home, "projects/retained/.git"), { recursive: true });
  writeFileSync(
    join(home, "clone-repositories.sh"),
    '#!/bin/sh\nprintf called > "$HOME/bootstrap-called"\n',
    { mode: 0o700 },
  );
  const script = readFileSync(`${canonical}/scripts/tools-ci.sh`, "utf8");
  const boundary = script.slice(script.indexOf('if [ "$HIVE_MANAGED_PROJECTS"'));
  assert.ok(boundary.startsWith("if "));
  for (const managed of ["true", "false"]) {
    const result = spawnSync("sh", ["-c", boundary], {
      env: { PATH: "/usr/bin:/bin", HOME: home, HIVE_MANAGED_PROJECTS: managed },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(home, "bootstrap-called")), managed === "false");
    assert.equal(
      readFileSync(join(home, "repositories.txt"), "utf8"),
      "user/retained|user/retained\n",
    );
    assert.ok(existsSync(join(home, "projects/retained/.git")));
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hive-coder-credentials-"));
  const home = join(root, "home");
  const config = join(home, ".config", "coderv2");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "url"), `${deployment}/\n`);
  writeFileSync(join(config, "session"), secret);
  writeFileSync(join(config, "organization"), "preserve-settings");
  const env = {
    ...process.env,
    HIVE_TEST_HOME: home,
    CODER_CONFIG_DIR: config,
    XDG_CONFIG_HOME: join(home, ".config"),
    CODER_SESSION_TOKEN: secret,
  };
  const run = (profile = "browser", agent = "printf 'agent-started\\n'", extraEnv = {}) => {
    // Substitute only the home lookup to keep tests away from real credentials.
    const script = entrypoint
      .replace(`\${coder_access_url_b64}`, encode(deployment))
      .replace(`\${workspace_profile_b64}`, encode(profile))
      .replace(
        `\${coder_credential_cleanup_script}`,
        cleanup.replace("Path.home()", 'Path(os.environ["HIVE_TEST_HOME"])'),
      )
      .replace(`\${agent_init_script}`, agent);
    return spawnSync("sh", ["-c", script], { encoding: "utf8", env: { ...env, ...extraEnv } });
  };
  return { root, home, config, env, run };
}

test("only the software profile provisions owner login and bypasses specialist cleanup", () => {
  for (const name of [
    "ai-dev-k8s",
    "browser-testing",
    "game-dev",
    "electronics",
    "infrastructure",
  ]) {
    const tf = readFileSync(`templates/${name}/main.tf`, "utf8");
    const login = tf.split('module "coder-login" {')[1].split("\n}")[0];
    assert.match(
      login,
      /count\s*=\s*local\.profile\.id == "software" \? data\.coder_workspace\.me\.start_count : 0/,
    );
    assert.match(
      tf,
      /command\s*=\s*\["sh", "-c", local\.profile\.id == "software" \? coder_agent\.main\.init_script : templatefile/,
    );
    assert.equal(
      readFileSync(`templates/${name}/scripts/coder-credential-cleanup.py`, "utf8"),
      cleanup,
    );
    assert.equal(
      readFileSync(`templates/${name}/scripts/specialist-agent-entrypoint.sh`, "utf8"),
      entrypoint,
    );
  }
});

for (const profile of ["browser", "game", "electronics", "infrastructure"]) {
  test(`${profile} removes persisted Hive login and inherited owner token before the agent starts`, () => {
    const f = fixture();
    try {
      const agent = `python3 -c 'import os; from pathlib import Path; assert "CODER_SESSION_TOKEN" not in os.environ; assert not (Path(os.environ["HIVE_TEST_HOME"])/".config/coderv2/session").exists(); print("agent-started")'`;
      const result = f.run(profile, agent);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /agent-started/);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
      assert.equal(readFileSync(join(f.config, "organization"), "utf8"), "preserve-settings");
      assert.equal(f.run(profile).status, 0, "cleanup must be idempotent");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("software cleanup is a no-op and keeps its persisted management credential", () => {
  const f = fixture();
  try {
    const code = cleanup.replace("Path.home()", 'Path(os.environ["HIVE_TEST_HOME"])');
    const result = spawnSync("python3", ["-c", code, encode(deployment), encode("software")], {
      env: f.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.config, "session"), "utf8"), secret);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("specialist migration preserves explicit credentials for another deployment", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.config, "url"), "https://other.example.test");
    assert.equal(f.run().status, 0);
    assert.equal(readFileSync(join(f.config, "session"), "utf8"), secret);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("specialist migration handles XDG and custom private config directories", () => {
  const f = fixture();
  try {
    const xdg = join(f.home, "xdg");
    const custom = join(f.home, "custom-config");
    for (const root of [join(xdg, "coderv2"), custom]) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "url"), "https://coder.example.test:443");
      writeFileSync(join(root, "session"), secret);
    }
    const result = f.run("infrastructure", "printf 'agent-started\\n'", {
      XDG_CONFIG_HOME: xdg,
      CODER_CONFIG_DIR: custom,
    });
    assert.equal(result.status, 0, result.stderr);
    for (const root of [f.config, join(xdg, "coderv2"), custom])
      assert.equal(existsSync(join(root, "session")), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a shared session symlink prevents agent startup and preserves its target", () => {
  const f = fixture();
  try {
    const target = join(f.root, "primary-session");
    writeFileSync(target, secret);
    rmSync(join(f.config, "session"));
    symlinkSync(target, join(f.config, "session"));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /agent-started/);
    assert.equal(existsSync(join(f.config, "session")), true);
    assert.equal(readFileSync(target, "utf8"), secret);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a hardlinked session prevents agent startup and preserves both credential paths", () => {
  const f = fixture();
  try {
    const shared = join(f.root, "shared-session");
    linkSync(join(f.config, "session"), shared);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /agent-started/);
    assert.equal(readFileSync(shared, "utf8"), secret);
    assert.equal(readFileSync(join(f.config, "session"), "utf8"), secret);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const failure of ["missing-url", "external-config", "unknown-profile"]) {
  test(`migration fails before agent startup for ${failure} without logging secrets`, () => {
    const f = fixture();
    try {
      let extra = {};
      let profile = "browser";
      if (failure === "missing-url") rmSync(join(f.config, "url"));
      if (failure === "unknown-profile") profile = "unexpected";
      if (failure === "external-config") {
        const external = join(f.root, "shared-config");
        mkdirSync(external);
        writeFileSync(join(external, "url"), deployment);
        writeFileSync(join(external, "session"), secret);
        extra = { CODER_CONFIG_DIR: external };
      }
      const result = f.run(profile, "printf 'agent-started\\n'", extra);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /agent-started/);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
      assert.match(result.stderr, /cleanup failed; agent was not started/);
      if (failure === "external-config")
        assert.equal(readFileSync(join(extra.CODER_CONFIG_DIR, "session"), "utf8"), secret);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}
