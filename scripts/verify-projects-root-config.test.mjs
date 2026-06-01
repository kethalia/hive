import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const HOME_ROOT_VALUE = "/home/coder";
const ENV_EXAMPLE_ENTRY = `HIVE_PROJECTS_ROOT=${HOME_ROOT_VALUE}`;
const COMPOSE_ENV_ENTRY = `HIVE_PROJECTS_ROOT=\${HIVE_PROJECTS_ROOT:-${HOME_ROOT_VALUE}}`;
const COMPOSE_VOLUME_ENTRY = `\${HIVE_PROJECTS_ROOT:-${HOME_ROOT_VALUE}}:\${HIVE_PROJECTS_ROOT:-${HOME_ROOT_VALUE}}:ro`;
const HELM_VALUES_ENTRY = `HIVE_PROJECTS_ROOT: "${HOME_ROOT_VALUE}"`;

const TRACKED_INPUT_FILES = [
  ".env.example",
  "Dockerfile",
  "services/terminal-proxy/Dockerfile",
  "docker-compose.local.yml",
  "docker-compose.prod.yml",
  "charts/hive-web/values.yaml",
  "charts/hive-terminal/values.yaml",
  "docs/deployment.md",
];

function readTrackedFile(relativePath) {
  assert.ok(
    !relativePath.startsWith(".planning/"),
    `${relativePath} must not read planning artifacts`,
  );
  assert.ok(!relativePath.startsWith(".audits/"), `${relativePath} must not read audit artifacts`);

  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function getComposeServiceBlock(composeText, serviceName) {
  const serviceHeader = `  ${serviceName}:`;
  const startIndex = composeText.indexOf(serviceHeader);
  assert.notEqual(startIndex, -1, `${serviceName} service is present`);

  const afterHeader = composeText.slice(startIndex + serviceHeader.length);
  const nextServiceMatch = afterHeader.match(/\n {2}[a-zA-Z0-9_-]+:\n/);
  const endIndex = nextServiceMatch
    ? startIndex + serviceHeader.length + nextServiceMatch.index
    : composeText.length;

  return composeText.slice(startIndex, endIndex);
}

test("verifier only reads tracked config and documentation inputs", () => {
  assert.deepEqual(TRACKED_INPUT_FILES, [
    ".env.example",
    "Dockerfile",
    "services/terminal-proxy/Dockerfile",
    "docker-compose.local.yml",
    "docker-compose.prod.yml",
    "charts/hive-web/values.yaml",
    "charts/hive-terminal/values.yaml",
    "docs/deployment.md",
  ]);

  for (const relativePath of TRACKED_INPUT_FILES) {
    assert.doesNotThrow(() => readTrackedFile(relativePath));
  }
});

test(".env.example documents the shared home root default", () => {
  const envExample = readTrackedFile(".env.example");

  assert.match(envExample, /Shared home root used by Git clone discovery/);
  assert.match(envExample, /web app must see this tree for sidebar scanning/);
  assert.match(envExample, /terminal proxy must use/);
  assert.match(envExample, /same root string as the Coder agent runtime/);
  assert.ok(envExample.includes(ENV_EXAMPLE_ENTRY), ".env.example includes HIVE_PROJECTS_ROOT");
});

test("Docker images create the default home root so unmounted images show an empty tree, not a missing root", () => {
  const webDockerfile = readTrackedFile("Dockerfile");
  const terminalDockerfile = readTrackedFile("services/terminal-proxy/Dockerfile");

  for (const [label, dockerfile] of [
    ["web", webDockerfile],
    ["terminal", terminalDockerfile],
  ]) {
    assert.match(dockerfile, /mkdir -p \/home\/coder/, `${label} image creates /home/coder`);
    assert.match(dockerfile, /chown .*\/home\/coder/, `${label} image grants runtime user access`);
  }
});

test("Compose local and production pass and mount the same home root to app and terminal-proxy", () => {
  for (const relativePath of ["docker-compose.local.yml", "docker-compose.prod.yml"]) {
    const composeText = readTrackedFile(relativePath);

    for (const serviceName of ["app", "terminal-proxy"]) {
      const serviceBlock = getComposeServiceBlock(composeText, serviceName);
      assert.ok(
        serviceBlock.includes(`- ${COMPOSE_ENV_ENTRY}`),
        `${relativePath} ${serviceName} must set ${COMPOSE_ENV_ENTRY}`,
      );
      assert.ok(
        serviceBlock.includes(`- ${COMPOSE_VOLUME_ENTRY}`),
        `${relativePath} ${serviceName} must bind-mount ${COMPOSE_VOLUME_ENTRY}`,
      );
    }
  }
});

test("Helm values expose HIVE_PROJECTS_ROOT with service-specific comments", () => {
  const webValues = readTrackedFile("charts/hive-web/values.yaml");
  const terminalValues = readTrackedFile("charts/hive-terminal/values.yaml");

  assert.ok(webValues.includes(HELM_VALUES_ENTRY), "hive-web values include HIVE_PROJECTS_ROOT");
  assert.match(webValues, /Home tree visible to the web process/);
  assert.match(webValues, /Git clone discovery\/sidebar scans/);

  assert.ok(
    terminalValues.includes(HELM_VALUES_ENTRY),
    "hive-terminal values include HIVE_PROJECTS_ROOT",
  );
  assert.match(terminalValues, /Must match the web\/Coder-agent home root string/);
  assert.match(terminalValues, /tmux sessions with cwd under the same repository tree/);
});

test("deployment docs cover the Git discovery and clone-terminal root contract", () => {
  const deploymentDocs = readTrackedFile("docs/deployment.md");

  for (const requiredText of [
    "## Git clone discovery and clone terminals",
    "web service, terminal proxy, and Coder agent runtime must agree on `HIVE_PROJECTS_ROOT`",
    `The default value is \`${HOME_ROOT_VALUE}\``,
    "not limited to a strict `projects` directory",
    "The web service scans `HIVE_PROJECTS_ROOT`",
    "looking for directory or file `.git` metadata",
    "The terminal proxy validates clone terminal requests",
    "must either be colocated with that home tree or receive an equivalent mount",
    "bind-mount `" + "$" + "{HIVE_PROJECTS_ROOT:-/home/coder}` read-only",
    "home folder is unavailable",
    "no Git clones were found",
    "Discovery runs on manual refresh",
    "does not currently auto-poll",
    "does not yet expose a dedicated UI control to terminate a clone session",
    "sanitized UI errors",
    "reason-code/count summaries",
    "There are no dedicated production metrics",
  ]) {
    assert.ok(
      deploymentDocs.includes(requiredText),
      `docs/deployment.md must mention: ${requiredText}`,
    );
  }
});
