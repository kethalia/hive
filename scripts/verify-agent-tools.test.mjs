import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("agent metadata, configuration preservation, and recovery boundaries", () => {
  const result = spawnSync("python3", ["scripts/agents/test_agent_tools.py"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("official Neon skill installation preserves user skills and rejects unsafe archives", () => {
  const result = spawnSync("python3", ["-B", "scripts/agents/test_neon_skill.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("official updates preserve user edits and failed tool installations", () => {
  const result = spawnSync("python3", ["-B", "scripts/agents/test_official_updates.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("optional agent integrations stay in software and do not block login", () => {
  const template = readFileSync("templates/ai-dev-k8s/main.tf", "utf8");
  const block = template.match(
    /resource "coder_script" "agent_integrations" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(block);
  assert.match(block, /count\s*= local.profile.id == "software" \? 1 : 0/);
  assert.match(block, /start_blocks_login = false/);
  const script = readFileSync("templates/ai-dev-k8s/scripts/agent-integrations.sh", "utf8");
  assert.match(script, /typescript-language-server@5\.1\.3 typescript@5\.9\.3/);
  assert.match(script, /typescript-lsp@claude-plugins-official/);
});

test("GitHub project discovery preserves credentials and validates pagination", () => {
  const result = spawnSync("python3", ["-B", "scripts/agents/test_github_projects.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("managed checkouts preserve work and enforce signed lifecycle boundaries", () => {
  const result = spawnSync("python3", ["-B", "scripts/agents/test_managed_projects.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
