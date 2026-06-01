import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const HOME_ROOT_VALUE = "/home/coder";
const ENV_EXAMPLE_ENTRY = `HIVE_PROJECTS_ROOT=${HOME_ROOT_VALUE}`;
const COMPOSE_ENV_ENTRY = `HIVE_PROJECTS_ROOT=\${HIVE_PROJECTS_ROOT:-${HOME_ROOT_VALUE}}`;
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

test(".env.example documents the shared workspace home root default", () => {
  const envExample = readTrackedFile(".env.example");

  assert.match(envExample, /Shared absolute POSIX workspace home root used by Git clone discovery/);
  assert.match(envExample, /web app scans this path inside the user's Coder workspace/);
  assert.match(envExample, /terminal proxy uses the same absolute root string/);
  assert.ok(envExample.includes(ENV_EXAMPLE_ENTRY), ".env.example includes HIVE_PROJECTS_ROOT");
});

test("Docker images include runtime prerequisites for workspace-root discovery", () => {
  const webDockerfile = readTrackedFile("Dockerfile");
  const terminalDockerfile = readTrackedFile("services/terminal-proxy/Dockerfile");

  assert.match(
    webDockerfile,
    /coder version/,
    "web image installs the coder CLI for workspace scans",
  );
  for (const [label, dockerfile] of [
    ["web", webDockerfile],
    ["terminal", terminalDockerfile],
  ]) {
    assert.match(dockerfile, /mkdir -p \/home\/coder/, `${label} image creates /home/coder`);
    assert.match(dockerfile, /chown .*\/home\/coder/, `${label} image grants runtime user access`);
  }
});

test("Compose local and production pass the same workspace home root to app and terminal-proxy", () => {
  for (const relativePath of ["docker-compose.local.yml", "docker-compose.prod.yml"]) {
    const composeText = readTrackedFile(relativePath);

    for (const serviceName of ["app", "terminal-proxy"]) {
      const serviceBlock = getComposeServiceBlock(composeText, serviceName);
      assert.ok(
        serviceBlock.includes(`- ${COMPOSE_ENV_ENTRY}`),
        `${relativePath} ${serviceName} must set ${COMPOSE_ENV_ENTRY}`,
      );
    }
  }
});

test("Helm values expose HIVE_PROJECTS_ROOT with service-specific comments", () => {
  const webValues = readTrackedFile("charts/hive-web/values.yaml");
  const terminalValues = readTrackedFile("charts/hive-terminal/values.yaml");

  assert.ok(webValues.includes(HELM_VALUES_ENTRY), "hive-web values include HIVE_PROJECTS_ROOT");
  assert.match(webValues, /Absolute POSIX workspace home tree path used/);
  assert.match(webValues, /inside Coder workspaces via coder ssh/);

  assert.ok(
    terminalValues.includes(HELM_VALUES_ENTRY),
    "hive-terminal values include HIVE_PROJECTS_ROOT",
  );
  assert.match(
    terminalValues,
    /Must match the web\/Coder-agent absolute POSIX workspace home root string/,
  );
  assert.match(terminalValues, /inside the Coder agent/);
});

test("deployment docs cover the Git discovery and clone-terminal root contract", () => {
  const deploymentDocs = readTrackedFile("docs/deployment.md");

  for (const requiredText of [
    "## Git clone discovery and clone terminals",
    "web service, terminal proxy, and Coder agent runtime must agree on `HIVE_PROJECTS_ROOT`",
    "The value must be an absolute POSIX path",
    `The default value is \`${HOME_ROOT_VALUE}\``,
    "not limited to a strict `projects` directory",
    "The web service scans `HIVE_PROJECTS_ROOT` inside the selected Coder workspace via `coder ssh`",
    "looking for directory or file `.git` metadata",
    "The terminal proxy validates clone terminal requests",
    "passes the requested clone path under the same root to the Coder agent PTY command",
    "containers do not need the repository tree mounted locally",
    "workspace home root is missing",
    "workspace-scoped Git section reports that no Git clones were found",
    "Discovery runs when a workspace row is expanded",
    "manual refresh for expanded workspaces",
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
