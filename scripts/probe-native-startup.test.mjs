import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load } from "./probe-native-startup-loader.mjs";

test("startup diagnostic rejects source drift and never changes readiness bounds", async () => {
  const url = new URL(
    "../templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs",
    import.meta.url,
  );
  const source = readFileSync(url, "utf8");
  const transformed = await load(url.href, {}, async () => ({ source, format: "module" }));
  assert.match(transformed.source, /NATIVE_STARTUP_TIMEOUT_MS = 20000/);
  assert.match(transformed.source, /Math\.min\(300,/);
  assert.match(transformed.source, /Math\.min\(100,/);
  assert.match(transformed.source, /diagnostic\?\.poll\(child, attempt\+\+\)/);
  assert.equal(
    transformed.source.split("sourceInputAuthority?.();").length,
    source.split("sourceInputAuthority?.();").length,
    "diagnostics must preserve every source-input fence",
  );
  assert.equal((await load(url.href, {}, async () => transformed)).source, transformed.source);
  await assert.rejects(
    load(url.href, {}, async () => ({
      source: source.replace("  let ws;", "  let socket;"),
      format: "module",
    })),
    /diagnostic_source_marker_changed/,
  );
});

test("startup stderr/error diagnostics retain only bounded categories", () => {
  const directory = mkdtempSync(join(tmpdir(), "hive-native-startup-redaction-"));
  try {
    const observer = new URL("./probe-native-startup-observer.mjs", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {EventEmitter} from 'node:events';
      import {startupObserver} from ${JSON.stringify(observer)};
      const d=startupObserver({sourceSha256:'a'.repeat(64),metadata:false});
      const child=new EventEmitter(); child.pid=process.pid; child.stderr=new EventEmitter();
      d.spawned(child,'ws://127.0.0.1:12345');
      child.stderr.emit('data',Buffer.from('ERROR synthetic-private-token=DO_NOT_SAVE\\nWebSocket listening ws://127.0.0.1:12345\\n'+ 'x'.repeat(20000)));
      d.socketError({code:'ECONNREFUSED',message:'DO_NOT_SAVE'},0);
      child.emit('exit',0,null);
    `,
      ],
      { env: { HIVE_NATIVE_STARTUP_DIAGNOSTICS: directory }, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    const raw = readFileSync(join(directory, files[0]), "utf8");
    assert.doesNotMatch(raw, /DO_NOT_SAVE|synthetic-private-token|ws:\/\//);
    const result = JSON.parse(raw);
    assert.equal(result.stderrBytes, 16384);
    assert.equal(result.stderrTruncated, true);
    assert.ok(
      result.events.some(
        (event) => event.type === "stderr" && event.categories.includes("websocket_listening"),
      ),
    );
    assert.ok(
      result.events.some(
        (event) => event.type === "websocket_error" && event.code === "ECONNREFUSED",
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
