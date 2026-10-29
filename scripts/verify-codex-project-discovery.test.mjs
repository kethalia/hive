import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function http(url, options = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            json: async () => JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    r.on("error", reject);
    r.end(options.body);
  });
}

import {
  createProjectDiscovery,
  startDiscoveryGateway,
} from "../templates/ai-dev-k8s/scripts/codex-project-discovery.mjs";

function fixture(controller) {
  const root = mkdtempSync(join(tmpdir(), "hive-discovery-")),
    helperPath = join(root, "helper.py"),
    issuer = generateKeyPairSync("ed25519");
  const code = `import json,sys,os\nr=json.load(sys.stdin)\nassert 'CODER_SESSION_TOKEN' not in os.environ and 'GITHUB_TOKEN' not in os.environ and 'OPENAI_API_KEY' not in os.environ\nprint(json.dumps({'schemaVersion':1,'provider':'github','providerAccountId':'123','repositories':[],'page':r['page'],'perPage':r['perPage'],'nextPage':None}))\n`;
  writeFileSync(helperPath, code, { mode: 0o600 });
  const config = {
    binding: {
      coderOrigin: "https://coder.example.com",
      hiveUserId: randomUUID(),
      ownerId: randomUUID(),
      workspaceId: randomUUID(),
      buildId: randomUUID(),
      agentId: randomUUID(),
      templateId: randomUUID(),
      appOrigin: "https://app.example.com",
      appId: randomUUID(),
    },
    hiveOrigin: "https://hive.example.com",
    issuerPublicKeyPem: issuer.publicKey.export({ format: "pem", type: "spki" }).toString(),
    issuerKeyId: "issuer",
    stateDirectory: root,
    helperPath,
    helperSha256: createHash("sha256").update(code).digest("hex"),
  };
  const host = createProjectDiscovery(config, controller);
  const ticket = (patch = {}) => {
    const now = Math.floor(Date.now() / 1000),
      claims = {
        iss: config.hiveOrigin,
        aud: config.binding.appOrigin,
        scope: "projects:discover",
        jti: randomUUID(),
        iat: now,
        exp: now + 60,
        binding: config.binding,
        request: { schemaVersion: 1, page: 1, perPage: 10 },
        ...patch,
      };
    const head = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "issuer" })).toString(
        "base64url",
      ),
      body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), issuer.privateKey).toString("base64url")}`;
  };
  return {
    host,
    config,
    ticket,
    root,
    close() {
      host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("pre-project discovery needs no native session and persists nonce replay rejection across restart", async () => {
  const f = fixture();
  try {
    const ticket = f.ticket();
    const result = await f.host.discover({ ticket });
    assert.equal(result.provider, "github");
    assert.equal(result.page, 1);
    await assert.rejects(f.host.discover({ ticket }));
    assert.throws(() => createProjectDiscovery(f.config));
    f.host.close();
    const restarted = createProjectDiscovery(f.config);
    try {
      await assert.rejects(restarted.discover({ ticket }));
    } finally {
      restarted.close();
    }
  } finally {
    f.close();
  }
});
test("signed pagination, exact owner/build/app and scope cannot be substituted", async () => {
  const f = fixture();
  try {
    for (const patch of [
      { scope: "session:read" },
      { binding: { ...f.config.binding, ownerId: randomUUID() } },
      { binding: { ...f.config.binding, buildId: randomUUID() } },
      { request: { schemaVersion: 1, page: 0, perPage: 100 } },
      { request: { schemaVersion: 1, page: 1, perPage: 101 } },
      { request: { schemaVersion: 1, page: 1, perPage: 10, command: "touch bad" } },
    ])
      await assert.rejects(f.host.discover({ ticket: f.ticket(patch) }));
    await assert.rejects(f.host.discover({ ticket: f.ticket(), page: 2 }));
  } finally {
    f.close();
  }
});
test("installed helper content replacement is rejected and never executes", async () => {
  const f = fixture();
  try {
    writeFileSync(f.config.helperPath, 'raise Exception("changed")');
    await assert.rejects(f.host.discover({ ticket: f.ticket() }));
  } finally {
    f.close();
  }
});
test("loopback HTTP route admits signed discovery and rejects forged app headers/arbitrary routes", async () => {
  const f = fixture(),
    gateway = await startDiscoveryGateway(
      { port: 0, appOrigin: f.config.binding.appOrigin },
      f.host,
    );
  try {
    const base = `http://127.0.0.1:${gateway.port}`,
      headers = { Host: "app.example.com", "Content-Type": "application/json" };
    const r = await http(`${base}/projects/discover`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ticket: f.ticket() }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).provider, "github");
    const forged = await http(`${base}/projects/discover`, {
      method: "POST",
      headers: { ...headers, "Coder-Session-Token": "forged" },
      body: JSON.stringify({ ticket: "forged" }),
    });
    assert.equal(forged.status, 403);
    assert.equal((await http(`${base}/thread/start`, { method: "POST", headers })).status, 404);
    assert.equal(
      (
        await http(`${base}/projects/discover`, {
          method: "POST",
          headers: { ...headers, Host: "evil.example" },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await gateway.close();
    f.close();
  }
});

test("signed project operations are exact-path scoped and accept bounded escaped first-task text", async () => {
  const calls = [];
  const f = fixture({
    async handle(path, request) {
      calls.push({ path, request });
      return { accepted: true };
    },
  });
  const gateway = await startDiscoveryGateway(
    { port: 0, appOrigin: f.config.binding.appOrigin },
    f.host,
  );
  try {
    const path = "/projects/tasks/start",
      request = {
        schemaVersion: 1,
        projectId: randomUUID(),
        repositoryId: "123",
        expectedAccountId: "456",
        taskId: randomUUID(),
        requestId: randomUUID(),
        revision: "a".repeat(40),
        model: "gpt-6.1-sol",
        effort: "low",
        text: "x" + "\n".repeat(32767),
      };
    const headers = { Host: "app.example.com", "Content-Type": "application/json" },
      base = `http://127.0.0.1:${gateway.port}`;
    const r = await http(base + path, {
      method: "POST",
      headers,
      body: JSON.stringify({ ticket: f.ticket({ scope: "projects:task:start", request }) }),
    });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].request.text, request.text);
    for (const patch of [
      { scope: "projects:discover" },
      { request: { ...request, text: "\u0000" } },
      { request: { ...request, command: "bad" } },
    ]) {
      const denied = await http(base + path, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ticket: f.ticket({ scope: "projects:task:start", request, ...patch }),
        }),
      });
      assert.equal(denied.status, 403);
    }
    assert.equal(calls.length, 1);
  } finally {
    await gateway.close();
    f.close();
  }
});
