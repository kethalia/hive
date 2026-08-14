import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const templateRoot = join(repositoryRoot, "templates");
const profiles = [
  {
    template: "ai-dev-k8s",
    id: "software",
    storage: "100Gi",
    web3: true,
  },
  {
    template: "orchestrator",
    id: "orchestrator",
    storage: "50Gi",
    web3: false,
  },
  {
    template: "game-dev",
    id: "game",
    storage: "150Gi",
    web3: false,
  },
  {
    template: "electronics",
    id: "electronics",
    storage: "100Gi",
    web3: false,
  },
  {
    template: "infrastructure",
    id: "infrastructure",
    storage: "75Gi",
    web3: false,
  },
];

function readTemplateFile(templateName, relativePath) {
  return readFileSync(join(templateRoot, templateName, relativePath), "utf8");
}

test("every workspace profile is a directly deployable Coder template", () => {
  const requiredFiles = [
    ".terraform.lock.hcl",
    "main.tf",
    "profile.json",
    "CLAUDE.md",
    "WORKSPACE.md",
    "README.md",
    "repositories.txt",
    "scripts/init.sh",
    "scripts/tools-ai.sh",
    "scripts/tools-ci.sh",
  ];

  for (const { template } of profiles) {
    for (const relativePath of requiredFiles) {
      assert.equal(
        existsSync(join(templateRoot, template, relativePath)),
        true,
        `${template}/${relativePath} must exist`,
      );
    }
  }
});

test("profile configuration controls image, resources, extensions, and optional tooling", () => {
  const seenIds = new Set();

  for (const expected of profiles) {
    const profile = JSON.parse(readTemplateFile(expected.template, "profile.json"));
    assert.equal(profile.id, expected.id);
    assert.equal(profile.resources.storage, expected.storage);
    assert.equal(profile.enable_web3, expected.web3);
    assert.match(profile.image, /^ghcr\.io\/kethalia\/hive-base@sha256:[0-9a-f]{64}$/);
    assert.match(profile.resources.cpu_request, /^\d+m?$/);
    assert.match(profile.resources.memory_request, /^\d+(?:Mi|Gi)$/);
    assert.match(profile.resources.cpu_limit, /^\d+m?$/);
    assert.match(profile.resources.memory_limit, /^\d+(?:Mi|Gi)$/);
    assert.ok(Array.isArray(profile.vscode_extensions));
    assert.equal(new Set(profile.vscode_extensions).size, profile.vscode_extensions.length);
    assert.equal(seenIds.has(profile.id), false, `duplicate profile id: ${profile.id}`);
    seenIds.add(profile.id);
  }
});

test("canonical Terraform consumes each profile overlay", () => {
  const terraform = readTemplateFile("ai-dev-k8s", "main.tf");

  for (const reference of [
    /jsondecode\(file\("\$\{path\.module\}\/profile\.json"\)\)/,
    /file\("\$\{path\.module\}\/WORKSPACE\.md"\)/,
    /local\.profile\.image/,
    /local\.profile\.resources\.storage/,
    /local\.profile\.resources\.cpu_request/,
    /local\.profile\.resources\.memory_request/,
    /local\.profile\.resources\.cpu_limit/,
    /local\.profile\.resources\.memory_limit/,
    /local\.profile\.vscode_extensions/,
    /local\.profile\.enable_web3/,
    /local\.profile\.id/,
  ]) {
    assert.match(terraform, reference);
  }
});

test("specialist templates stay synchronized with the canonical Kubernetes scaffold", () => {
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts/sync-workspace-profile-templates.mjs"), "--check"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /synchronized \(4 variants\)/);
});

test("repository manifests remain narrow and parseable", () => {
  for (const { template } of profiles) {
    const entries = readTemplateFile(template, "repositories.txt")
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry && !entry.startsWith("#"));

    for (const entry of entries) {
      assert.match(entry, /^[a-z0-9_.-]+\/[a-z0-9_.-]+\|[a-z0-9_.-]+\/[a-z0-9_.-]+$/i);
    }
  }

  assert.equal(
    readTemplateFile("electronics", "repositories.txt")
      .split("\n")
      .filter((entry) => entry.trim() && !entry.trim().startsWith("#")).length,
    0,
  );

  assert.match(readTemplateFile("game-dev", "repositories.txt"), /chillwhales\/realm-of-chill/);
  assert.doesNotMatch(readTemplateFile("ai-dev-k8s", "repositories.txt"), /realm-of-chill/);
  assert.match(readTemplateFile("infrastructure", "repositories.txt"), /kethalia\/k8s-cluster/);
  assert.doesNotMatch(readTemplateFile("ai-dev-k8s", "repositories.txt"), /kethalia\/k8s-cluster/);
});

test("profile guidance encodes the intended interactive boundary", () => {
  const orchestrator = readTemplateFile("orchestrator", "CLAUDE.md");
  const game = readTemplateFile("game-dev", "CLAUDE.md");
  const electronics = readTemplateFile("electronics", "CLAUDE.md");
  const infrastructure = readTemplateFile("infrastructure", "CLAUDE.md");

  assert.match(orchestrator, /Never delete a[\s\S]*without explicit user confirmation/);
  assert.match(orchestrator, /interactive TUI conversations/);
  assert.match(game, /does not guarantee GPU access/);
  assert.match(electronics, /does not expose local USB or serial hardware/);
  assert.match(
    infrastructure,
    /Applying infrastructure[\s\S]*requires explicit user\s+authorization/,
  );
});
