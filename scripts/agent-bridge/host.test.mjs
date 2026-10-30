import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
