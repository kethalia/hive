import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Exercise the installed transformed modules, with the same existing behavioral
// tests. The resolver maps only exact manifest module names, never test/helpers.
function compiled(t, requiredModules = ["codex-project-supervisor.mjs"]) {
  const root = resolve("."),
    directory = mkdtempSync(join(tmpdir(), "hive-compiled-host-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "package"),
    loader = join(directory, "loader.mjs"),
    mappingLog = join(directory, "mapped-modules.jsonl");
  execFileSync(process.execPath, ["scripts/build-codex-host-bundle.mjs", output], {
    stdio: "pipe",
  });
  const manifest = JSON.parse(readFileSync(join(output, "package-manifest.json")));
  const prefix = pathToFileURL(join(root, "templates/ai-dev-k8s/scripts/")).href;
  writeFileSync(
    loader,
    `
    import {appendFileSync} from "node:fs";
    const mappingLog=${JSON.stringify(mappingLog)};
    const prefix=${JSON.stringify(prefix)}, destination=${JSON.stringify(pathToFileURL(`${output}/`).href)};
    const names=new Set(${JSON.stringify(Object.keys(manifest.files).filter((name) => name.endsWith(".mjs")))});
    export async function resolve(specifier,context,next){
      const found=await next(specifier,context);
      if(found.url.startsWith(prefix)&&names.has(found.url.slice(prefix.length))) {
        appendFileSync(mappingLog,JSON.stringify(found.url.slice(prefix.length))+"\\n");
        return {...found,url:destination+found.url.slice(prefix.length)};
      }
      return found;
    }
  `,
  );
  const register = `import{register}from'node:module';register(${JSON.stringify(pathToFileURL(loader).href)});`;
  return (files) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(register)}`,
        "--test",
        "--test-reporter=tap",
        ...files,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );
    assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
    assert.match(result.stdout, /# tests [1-9][0-9]*/);
    const mapped = new Set(readFileSync(mappingLog, "utf8").trim().split("\n").map(JSON.parse));
    for (const name of requiredModules)
      assert.ok(mapped.has(name), `Expected installed module was not exercised: ${name}`);
    t.diagnostic(result.stdout.trim());
  };
}
test("compiled package preserves controller, startup fences and session bridge behavior", {
  timeout: 100000,
}, (t) => {
  compiled(t)([
    "scripts/verify-codex-project-controller.test.mjs",
    "scripts/verify-codex-native-startup.test.mjs",
    "scripts/verify-codex-session-bridge.test.mjs",
  ]);
});
test("compiled delivery preserves source progression, native facts and collector signatures", (t) => {
  compiled(t, [
    "delivery-manager-adapter.mjs",
    "delivery-native-spool.mjs",
    "delivery-github-collector.mjs",
  ])([
    "scripts/verify-delivery-manager-adapter.test.mjs",
    "scripts/verify-delivery-native-spool.test.mjs",
    "scripts/verify-delivery-github-collector.test.mjs",
  ]);
});
test("compiled source application preserves input barriers and recovery", {
  timeout: 100000,
}, (t) => {
  compiled(t, ["codex-source-application.mjs", "delivery-source-apply-client.mjs"])([
    "scripts/verify-codex-source-input.test.mjs",
    "scripts/verify-codex-source-application.test.mjs",
    "scripts/verify-codex-project-terminal.test.mjs",
  ]);
});
test("compiled namespace preserves actual native WS, CLI, child and resume isolation", {
  skip: process.env.HIVE_TEST_NATIVE_CODEX !== "1",
  timeout: 100000,
}, (t) => {
  compiled(t)(["scripts/verify-codex-native-namespace.test.mjs"]);
});
