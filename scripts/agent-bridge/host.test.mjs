import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configDigest, createAgentBridge, responsePayload } from "./host.mjs";

const keys = generateKeyPairSync("ed25519"),
  sha = (x) => createHash("sha256").update(x).digest("hex");
const origin = "https://coder.example",
  appOrigin = "https://agent.example";
const binding = {
  coderOrigin: origin,
  ownerId: randomUUID(),
  workspaceId: randomUUID(),
  buildId: randomUUID(),
  agentId: randomUUID(),
  templateId: randomUUID(),
  appOrigin,
  appId: randomUUID(),
};
const config = {
  issuer: "https://hive.example",
  issuerKeyId: "test",
  issuerPublicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
  binding,
  profile: "software",
  home: "/home/coder",
  manifestSha256: "a".repeat(64),
  helperSha256: "",
};
function issue(request, lifetimeId = null, extra = {}) {
  const now = Math.floor(Date.now() / 1000),
    claims = {
      iss: config.issuer,
      aud: appOrigin,
      scope: "agent:operation:v1",
      jti: randomUUID(),
      iat: now,
      exp: now + 60,
      lifetimeId,
      binding: { ...binding, hiveUserId: randomUUID() },
      request,
      ...extra,
    };
  const encoded = [{ alg: "EdDSA", typ: "JWT", kid: "test" }, claims]
    .map((x) => Buffer.from(JSON.stringify(x)).toString("base64url"))
    .join(".");
  return {
    claims,
    token: `${encoded}.${sign(null, Buffer.from(encoded), keys.privateKey).toString("base64url")}`,
  };
}
test("signed agent bridge binds requests, executes fixed helper and rejects replay and tampering", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-bridge-")),
    path = join(dir, "helper.py");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = Buffer.from(
    'import json,sys\nr=json.load(sys.stdin)\nassert "source" not in r or r["source"].startswith("import json,sys")\nprint(json.dumps({"ok":True,"data":{"operation":r["operation"]}}))\n',
  );
  await writeFile(path, source, { mode: 0o600 });
  config.helperSha256 = sha(source);
  const bridge = createAgentBridge(config, { helperPath: path });
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}/agent/operation`;
  const post = (token) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: token }),
    });
  const first = issue({ operation: "identity" });
  const identity = await (await post(first.token)).json();
  const { proof, ...unsigned } = identity;
  assert.equal(identity.requestId, first.claims.jti);
  assert.equal(identity.result.data.configDigest, configDigest(config));
  assert.ok(
    verify(
      null,
      Buffer.from(responsePayload(unsigned)),
      identity.result.data.publicKeyPem,
      Buffer.from(proof, "base64url"),
    ),
  );
  assert.equal((await post(first.token)).status, 400);
  for (const operation of ["inventory", "sessions", "install", "disable", "configure-coder"]) {
    const grant = issue({ operation }, identity.lifetimeId),
      reply = await (await post(grant.token)).json();
    const { proof: signature, ...result } = reply;
    assert.ok(
      verify(
        null,
        Buffer.from(responsePayload(result)),
        identity.result.data.publicKeyPem,
        Buffer.from(signature, "base64url"),
      ),
    );
    assert.deepEqual(reply.result, { ok: true, data: { operation } });
  }
  const resume = issue({ operation: "resume", key: `codex-${randomUUID()}` }, identity.lifetimeId);
  assert.deepEqual((await (await post(resume.token)).json()).result, {
    ok: true,
    data: { operation: "resume" },
  });
  for (const request of [
    { operation: "rename-terminal-session", oldName: "git-clone-reserved", newName: "safe" },
    { operation: "rename-terminal-session", oldName: "safe", newName: "unsafe;command" },
    { operation: "kill-terminal-session", sessionName: "prefix:window" },
    { operation: "kill-terminal-session", sessionName: "safe", socket: "native" },
    {
      operation: "codex-account",
      account: {
        action: "connect",
        lifetimeId: identity.lifetimeId,
        generation: 0,
        root: "/arbitrary",
      },
    },
  ])
    assert.equal((await post(issue(request, identity.lifetimeId).token)).status, 400);
  const badResume = issue({ operation: "resume", key: "../../arbitrary" }, identity.lifetimeId);
  assert.equal((await post(badResume.token)).status, 400);
  const invalid = issue({ operation: "install", source: "malicious" }, identity.lifetimeId);
  assert.equal((await post(invalid.token)).status, 400);
  const wrong = issue({ operation: "inventory" }, identity.lifetimeId, {
    binding: { ...binding, buildId: randomUUID(), hiveUserId: randomUUID() },
  });
  assert.equal((await post(wrong.token)).status, 400);
  await writeFile(path, "malicious change");
  const changed = issue({ operation: "inventory" }, identity.lifetimeId),
    result = await (await post(changed.token)).json();
  assert.deepEqual(result.result, { ok: false, error: "agent_operation_failed" });
});

test("oversized helper output fails closed without returning its content", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-output-")),
    path = join(dir, "helper.py");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = Buffer.from(
    'import json\nprint(json.dumps({"ok":True,"data":"x" * (8 * 1024 * 1024)}))\n',
  );
  await writeFile(path, source, { mode: 0o600 });
  const local = { ...config, helperSha256: sha(source) },
    bridge = createAgentBridge(local, { helperPath: path });
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  t.after(() => bridge.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}/agent/operation`;
  const post = (token) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: token }),
    });
  const identity = await (await post(issue({ operation: "identity" }).token)).json();
  const response = await post(issue({ operation: "sessions" }, identity.lifetimeId).token);
  const text = await response.text();
  assert.ok(text.length < 1024);
  assert.deepEqual(JSON.parse(text).result, { ok: false, error: "agent_operation_failed" });
});

test("fixed notification capability installs pinned assets through stdin and refuses stale generations or asset replacement", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-notifications-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = new Map([
    ["agent-tools.py", Buffer.from('import json; print(json.dumps({"ok":True,"data":{}}))')],
    ["agent-host.mjs", await readFile(new URL("./host.mjs", import.meta.url))],
    [
      "codex-account.mjs",
      Buffer.from("// Pinned account fixture, not invoked by notification tests\n"),
    ],
    ["claude-account.mjs", Buffer.from("// pinned Claude fixture\n")],
    ["claude-account-driver.py", Buffer.from("# pinned Claude driver fixture\n")],
    ["agent-start.mjs", await readFile(new URL("./start.mjs", import.meta.url))],
    [
      "notifications-install.py",
      await readFile(new URL("../notifications/install.py", import.meta.url)),
    ],
    [
      "notifications-hook.py",
      await readFile(new URL("../notifications/agent-hook.py", import.meta.url)),
    ],
  ]);
  for (const [name, raw] of files) await writeFile(join(dir, name), raw, { mode: 0o600 });
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      files: Object.fromEntries([...files].map(([name, raw]) => [name, sha(raw)])),
    }),
  );
  await writeFile(join(dir, "manifest.json"), manifest, { mode: 0o600 });
  const codex = join(dir, "custom-codex"),
    claude = join(dir, "custom-claude");
  await mkdir(codex);
  await mkdir(claude);
  const prior = {
    theme: "preserved",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "unrelated" }] }] },
  };
  await writeFile(join(codex, "hooks.json"), JSON.stringify(prior));
  await writeFile(join(claude, "settings.json"), JSON.stringify(prior));
  const commands = [];
  const bridge = createAgentBridge(
    {
      ...config,
      home: dir,
      helperSha256: sha(files.get("agent-tools.py")),
      manifestSha256: sha(manifest),
    },
    {
      helperPath: join(dir, "agent-tools.py"),
      environment: { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude },
      spawn: (command, args, options) => {
        commands.push([command, args, options.env]);
        return spawn(command, args, options);
      },
    },
  );
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  t.after(() => bridge.close());
  const endpoint = `http://127.0.0.1:${bridge.server.address().port}/agent/operation`;
  const post = async (request) =>
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: request.token }),
    });
  const identity = await (await post(issue({ operation: "identity" }))).json();
  const operation = {
    operation: "install-notifications",
    sourceId: randomUUID(),
    generation: 1,
    createdAt: "2026-11-06T00:00:00.000Z",
    token: "d".repeat(64),
  };
  assert.equal(
    (await post(issue({ ...operation, url: "https://arbitrary.invalid" }, identity.lifetimeId)))
      .status,
    400,
  );
  const run = async (value) =>
    (await (await post(issue(value, identity.lifetimeId))).json()).result;
  const installed = await run(operation);
  assert.equal(installed.ok, true);
  assert.equal(installed.data.callbackOrigin, config.issuer);
  assert.equal(installed.data.credentialHash, sha(operation.token));
  assert.ok(!JSON.stringify(installed).includes(operation.token));
  assert.ok(!JSON.stringify(commands).includes(operation.token));
  const statePath = join(dir, ".local/share/hive/notifications/config.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.url, `${config.issuer}/api/notifications/events`);
  assert.equal(state.token, operation.token);
  const readHooks = async (path) => JSON.parse(await readFile(path, "utf8"));
  const first = await readHooks(join(codex, "hooks.json"));
  assert.equal(first.theme, "preserved");
  assert.equal(first.hooks.Stop[0].hooks[0].command, "unrelated");
  assert.equal((await run(operation)).ok, true);
  assert.deepEqual(await readHooks(join(codex, "hooks.json")), first);
  const newer = { ...operation, generation: 2, token: "e".repeat(64) };
  assert.equal((await run(newer)).ok, true);
  assert.equal((await run(operation)).ok, false);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).token, newer.token);
  assert.equal((await run({ ...newer, token: "f".repeat(64) })).ok, false);
  await writeFile(join(dir, "notifications-hook.py"), "tampered hook");
  assert.equal((await run({ ...newer, generation: 3 })).ok, false);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).generation, 2);
});
