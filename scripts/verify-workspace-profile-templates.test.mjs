/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are constrained to the repository template catalog. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const templateRoot = join(repositoryRoot, "templates");
const profiles = [
  {
    template: "ai-dev-k8s",
    id: "software",
    imageVariant: "cli",
    storage: "100Gi",
    capabilities: {
      browser: false,
      desktop: false,
      editor: true,
      file_browser: true,
      web3: true,
    },
  },
  {
    template: "browser-testing",
    id: "browser",
    imageVariant: "browser",
    storage: "50Gi",
    capabilities: {
      browser: true,
      desktop: true,
      editor: true,
      file_browser: true,
      web3: false,
    },
  },
  {
    template: "game-dev",
    id: "game",
    imageVariant: "game",
    storage: "150Gi",
    capabilities: {
      browser: false,
      desktop: true,
      editor: true,
      file_browser: true,
      web3: false,
    },
  },
  {
    template: "electronics",
    id: "electronics",
    imageVariant: "electronics",
    storage: "100Gi",
    capabilities: {
      browser: false,
      desktop: true,
      editor: true,
      file_browser: true,
      web3: false,
    },
  },
  {
    template: "infrastructure",
    id: "infrastructure",
    imageVariant: "infrastructure",
    rolloutFromImageVariant: "cli",
    storage: "75Gi",
    capabilities: {
      browser: false,
      desktop: false,
      editor: true,
      file_browser: true,
      web3: false,
    },
  },
];

function readTemplateFile(templateName, relativePath) {
  return readFileSync(join(templateRoot, templateName, relativePath), "utf8");
}

test("every workspace profile is a directly deployable Kubernetes Coder template", () => {
  const requiredFiles = [
    ".terraform.lock.hcl",
    "main.tf",
    "profile.json",
    "CLAUDE.md",
    "WORKSPACE_ROUTING.md",
    "WORKSPACE.md",
    "README.md",
    "repositories.txt",
    "scripts/init.sh",
    "scripts/tools-ai.sh",
    "scripts/tools-ci.sh",
  ];

  assert.equal(existsSync(join(templateRoot, "ai-dev")), false);
  assert.equal(existsSync(join(templateRoot, "orchestrator")), false);
  for (const { template } of profiles) {
    for (const relativePath of requiredFiles) {
      assert.equal(
        existsSync(join(templateRoot, template, relativePath)),
        true,
        `${template}/${relativePath} must exist`,
      );
    }
    assert.match(readTemplateFile(template, "main.tf"), /kubernetes_deployment_v1/);
  }
});

test("profile configuration defines exact image, resources, and runtime capabilities", () => {
  const seenIds = new Set();
  const cliImage = JSON.parse(readTemplateFile("ai-dev-k8s", "profile.json")).image;

  for (const expected of profiles) {
    const profile = JSON.parse(readTemplateFile(expected.template, "profile.json"));
    assert.equal(profile.id, expected.id);
    if (expected.rolloutFromImageVariant && profile.pending_image_variant !== undefined) {
      assert.equal(profile.image_variant, expected.rolloutFromImageVariant);
      assert.equal(profile.pending_image_variant, expected.imageVariant);
      assert.equal(profile.image, cliImage);
    } else {
      assert.equal(profile.image_variant, expected.imageVariant);
      assert.equal(profile.pending_image_variant, undefined);
      if (expected.rolloutFromImageVariant) assert.notEqual(profile.image, cliImage);
    }
    assert.equal(profile.resources.storage, expected.storage);
    assert.deepEqual(profile.capabilities, expected.capabilities);
    assert.equal(profile.enable_web3, undefined);
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

test("canonical Terraform gates every optional workspace surface", () => {
  const terraform = readTemplateFile("ai-dev-k8s", "main.tf");

  for (const reference of [
    /jsondecode\(file\("\$\{path\.module\}\/profile\.json"\)\)/,
    /file\("\$\{path\.module\}\/WORKSPACE\.md"\)/,
    /local\.profile\.image/,
    /local\.profile\.image_variant/,
    /local\.profile\.resources\.storage/,
    /local\.profile\.resources\.cpu_request/,
    /local\.profile\.resources\.memory_request/,
    /local\.profile\.resources\.cpu_limit/,
    /local\.profile\.resources\.memory_limit/,
    /local\.profile\.vscode_extensions/,
    /local\.profile\.capabilities\.web3/,
    /local\.profile\.capabilities\.browser/,
    /local\.profile\.capabilities\.desktop/,
    /local\.profile\.capabilities\.editor/,
    /local\.profile\.capabilities\.file_browser/,
    /local\.profile\.id/,
    /module "coder-login"/,
  ]) {
    assert.match(terraform, reference);
  }

  assert.match(
    terraform,
    /resource "coder_script" "tools_browser" \{[\s\S]*?count\s*=\s*local\.profile\.capabilities\.browser \? 1 : 0/,
  );
  assert.match(
    terraform,
    /module "kasmvnc" \{[\s\S]*?count\s*=\s*local\.profile\.capabilities\.desktop \? data\.coder_workspace\.me\.start_count : 0/,
  );
  assert.match(
    terraform,
    /module "code-server" \{[\s\S]*?count\s*=\s*local\.profile\.capabilities\.editor \? data\.coder_workspace\.me\.start_count : 0/,
  );
  assert.match(
    terraform,
    /resource "coder_app" "filebrowser" \{[\s\S]*?count\s*=\s*local\.profile\.capabilities\.file_browser \? 1 : 0/,
  );
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

test("profile synchronization detects and removes obsolete shared scripts", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "workspace-profile-sync-"));
  const fixtureTemplates = join(fixtureRoot, "templates");
  const canonical = join(fixtureTemplates, "ai-dev-k8s");
  const syncScript = join(repositoryRoot, "scripts/sync-workspace-profile-templates.mjs");
  const targetNames = ["browser-testing", "game-dev", "electronics", "infrastructure"];

  mkdirSync(join(canonical, "scripts"), { recursive: true });
  writeFileSync(join(canonical, ".terraform.lock.hcl"), "canonical lock\n");
  writeFileSync(join(canonical, "main.tf"), "# canonical Terraform\n");
  writeFileSync(join(canonical, "WORKSPACE_ROUTING.md"), "# Canonical routing\n");
  writeFileSync(join(canonical, "scripts", "init.sh"), "#!/bin/sh\n");

  for (const targetName of targetNames) {
    mkdirSync(join(fixtureTemplates, targetName, "scripts"), { recursive: true });
  }
  const obsolete = join(fixtureTemplates, "browser-testing", "scripts", "obsolete-shared.sh");
  writeFileSync(obsolete, "#!/bin/sh\n");

  const drift = spawnSync(process.execPath, [syncScript, "--check"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /templates\/browser-testing\/scripts\/obsolete-shared\.sh/);

  const synchronized = spawnSync(process.execPath, [syncScript], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  assert.equal(synchronized.status, 0, synchronized.stderr);
  assert.match(synchronized.stdout, /removed 1 obsolete scripts/);
  assert.equal(existsSync(obsolete), false);

  const verified = spawnSync(process.execPath, [syncScript, "--check"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  assert.equal(verified.status, 0, verified.stderr);
  for (const targetName of targetNames) {
    assert.equal(
      readFileSync(join(fixtureTemplates, targetName, "WORKSPACE_ROUTING.md"), "utf8"),
      "# Canonical routing\n",
    );
  }
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

  for (const emptyManifest of ["browser-testing", "electronics"]) {
    assert.equal(
      readTemplateFile(emptyManifest, "repositories.txt")
        .split("\n")
        .filter((entry) => entry.trim() && !entry.trim().startsWith("#")).length,
      0,
    );
  }

  assert.match(readTemplateFile("game-dev", "repositories.txt"), /chillwhales\/realm-of-chill/);
  assert.doesNotMatch(readTemplateFile("ai-dev-k8s", "repositories.txt"), /realm-of-chill/);
  assert.match(readTemplateFile("infrastructure", "repositories.txt"), /kethalia\/k8s-cluster/);
  assert.match(readTemplateFile("ai-dev-k8s", "repositories.txt"), /kethalia\/k8s-cluster/);
  assert.match(readTemplateFile("ai-dev-k8s", "repositories.txt"), /kethalia\/workflows/);
});

test("profile guidance encodes the intended interactive and capability boundaries", () => {
  const software = readTemplateFile("ai-dev-k8s", "CLAUDE.md");
  const browser = readTemplateFile("browser-testing", "CLAUDE.md");
  const game = readTemplateFile("game-dev", "CLAUDE.md");
  const electronics = readTemplateFile("electronics", "CLAUDE.md");
  const infrastructure = readTemplateFile("infrastructure", "CLAUDE.md");

  assert.match(software, /Never delete a[\s\S]*without explicit user confirmation/);
  assert.match(software, /coder templates list/);
  assert.match(browser, /browser automation/);
  assert.match(browser, /cookies, downloads, traces, screenshots/);
  assert.match(game, /does not guarantee GPU access/);
  assert.match(electronics, /does not expose local USB or serial hardware/);
  assert.match(
    infrastructure,
    /Applying infrastructure[\s\S]*requires explicit user\s+authorization/,
  );

  for (const template of ["ai-dev-k8s", "game-dev", "electronics", "infrastructure"]) {
    assert.doesNotMatch(readTemplateFile(template, "WORKSPACE.md"), /headed Playwright/);
  }
});

test("every profile receives the same workspace routing and interactive handoff contract", () => {
  const routing = readTemplateFile("ai-dev-k8s", "WORKSPACE_ROUTING.md");

  for (const { template } of profiles) {
    assert.equal(readTemplateFile(template, "WORKSPACE_ROUTING.md"), routing);
    assert.match(routing, new RegExp(`\\b${template}\\b`));
  }

  assert.match(routing, /Only `ai-dev-k8s` orchestrates workspaces/);
  assert.match(routing, /Specialist profiles do not create, start, stop, or delete/);
  assert.match(routing, /do not download a replacement browser/);
  assert.match(routing, /do not[\s\S]*Playwright browser or system-dependency installers/);
  assert.match(routing, /keep the interaction in Hive's TUI/);
  assert.match(routing, /Workspace handoff required/);
  assert.match(routing, /Do not use retired[\s\S]*Tasks or New Task workflows/);

  for (const { template } of profiles) {
    const terraform = readTemplateFile(template, "main.tf");
    assert.match(terraform, /trimspace\(file\("\$\{path\.module\}\/CLAUDE\.md"\)\)/);
    assert.match(terraform, /trimspace\(file\("\$\{path\.module\}\/WORKSPACE_ROUTING\.md"\)\)/);
  }
});
