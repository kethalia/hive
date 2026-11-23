import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { test } from "node:test";
import { createHostRegistration } from "../templates/ai-dev-k8s/scripts/codex-host-registration.mjs";

function fixture() {
  const issuer = generateKeyPairSync("ed25519");
  let saves = 0;
  let revoked;
  const config = {
    hiveOrigin: "https://hive.example.com",
    coderOrigin: "https://coder.example.com",
    hiveUserId: randomUUID(),
    agentId: randomUUID(),
    templateId: randomUUID(),
    appId: randomUUID(),
    appOrigin: "https://app.example.com",
    issuerPublicKeyPem: issuer.publicKey.export({ format: "pem", type: "spki" }).toString(),
    issuerKeyId: "issuer",
  };
  const supervisor = {
    config: {
      ownerId: randomUUID(),
      workspaceId: randomUUID(),
      buildId: randomUUID(),
      projects: [{ projectId: randomUUID(), repositoryId: "123" }],
    },
    state: { status: "ready", serverInstanceId: randomUUID() },
    runtime: { alive: () => true },
    save() {
      saves++;
    },
    registrationBinding() {
      return { threadId: "registered-native-thread" };
    },
    onRevoked(fn) {
      revoked = fn;
      return () => {};
    },
  };
  let calls = [],
    sequence = 0,
    nonce = randomUUID(),
    registrationId = randomUUID(),
    handler;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (handler) return handler(url, init);
    const body = JSON.parse(init.body);
    if (url.endsWith("/heartbeat")) {
      assert.equal(body.sequence, ++sequence);
      assert.equal(body.nonce, nonce);
      nonce = randomUUID();
    } else {
      assert.equal(body.threads[0].threadId, "registered-native-thread");
      const payload = `hive-registration-v1\n${createHash("sha256").update(body.grant).digest("hex")}\n${JSON.stringify({ serverInstanceId: body.serverInstanceId, protocolVersion: body.protocolVersion, threads: body.threads, hostPublicKeyPem: body.hostPublicKeyPem })}`;
      assert(
        verify(
          null,
          Buffer.from(payload),
          createPublicKey(body.hostPublicKeyPem),
          Buffer.from(body.proof, "base64url"),
        ),
      );
    }
    return Response.json({
      registrationId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      sequence,
      nonce,
    });
  };
  const host = createHostRegistration(supervisor, config, fetcher);
  const grant = (generation = 1, patch = {}) => {
    const now = Math.floor(Date.now() / 1000),
      claims = {
        iss: config.hiveOrigin,
        aud: "hive:workspace-registration",
        scope: "workspace:register",
        jti: randomUUID(),
        iat: now,
        exp: now + 60,
        generation,
        binding: {
          coderOrigin: config.coderOrigin,
          hiveUserId: config.hiveUserId,
          ownerId: supervisor.config.ownerId,
          workspaceId: supervisor.config.workspaceId,
          buildId: supervisor.config.buildId,
          agentId: config.agentId,
          templateId: config.templateId,
          appOrigin: config.appOrigin,
          appId: config.appId,
          projects: supervisor.config.projects,
        },
        ...patch,
      };
    const head = Buffer.from(
        JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: config.issuerKeyId }),
      ).toString("base64url"),
      body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return (
      head +
      "." +
      body +
      "." +
      sign(null, Buffer.from(`${head}.${body}`), issuer.privateKey).toString("base64url")
    );
  };
  return {
    host,
    grant,
    supervisor,
    config,
    calls,
    get saves() {
      return saves;
    },
    setHandler(fn) {
      handler = fn;
    },
    revoke() {
      revoked();
    },
  };
}
test("pinned grant yields real host proof, uses fixed native thread, renews without new connection", async () => {
  const f = fixture();
  try {
    assert(!f.host.isActive());
    const result = await f.host.bootstrap({ grant: f.grant() });
    assert(f.host.isActive());
    assert.equal(Object.keys(result).sort().join(","), "expiresAt,registrationId");
    assert.equal(f.supervisor.state.controllerRegistration.status, "registered");
    assert(f.saves >= 3);
    await f.host.heartbeat();
    assert(f.host.isActive());
    assert.equal(f.calls.length, 2);
    for (const c of f.calls) {
      assert(c.url.startsWith(`${f.config.hiveOrigin}/api/codex-host/registrations`));
      assert.equal(c.init.redirect, "manual");
      assert.deepEqual(c.init.headers, { "Content-Type": "application/json" });
    }
  } finally {
    f.host.close();
  }
});
test("replay and changed independent binding fail before network", async () => {
  const f = fixture();
  try {
    const grant = f.grant();
    await f.host.bootstrap({ grant });
    await assert.rejects(f.host.bootstrap({ grant }));
    const calls = f.calls.length;
    await assert.rejects(f.host.bootstrap({ grant: f.grant(2, { binding: {} }) }));
    await assert.rejects(f.host.bootstrap({ grant: f.grant(2, { iss: "https://evil.example" }) }));
    assert.equal(f.calls.length, calls);
  } finally {
    f.host.close();
  }
});
test("ambiguous redemption burns generation durably; restart cannot replay it", async () => {
  const f = fixture();
  try {
    f.setHandler(() => {
      throw new Error("network lost");
    });
    const grant = f.grant();
    await assert.rejects(f.host.bootstrap({ grant }));
    assert.equal(f.supervisor.state.controllerRegistration.status, "pending");
    assert(!f.host.isActive());
    const count = f.calls.length;
    await assert.rejects(f.host.bootstrap({ grant }));
    assert.equal(f.calls.length, count);
    f.host.close();
    const restarted = createHostRegistration(f.supervisor, f.config, () => {
      throw new Error("must not fetch");
    });
    try {
      await assert.rejects(restarted.bootstrap({ grant }));
    } finally {
      restarted.close();
    }
  } finally {
    f.host.close();
  }
});
test("heartbeat rejection and native revocation close read authority", async () => {
  const f = fixture();
  let revokes = 0;
  f.host.onRevoked(() => revokes++);
  try {
    await f.host.bootstrap({ grant: f.grant() });
    f.setHandler(() => new Response(null, { status: 403 }));
    await f.host.heartbeat();
    assert(!f.host.isActive());
    assert(revokes >= 2);
    f.revoke();
    assert(!f.host.isActive());
  } finally {
    f.host.close();
  }
});
test("rejects algorithm substitutions, expired grants, and unregistered project threads", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.host.bootstrap({ grant: f.grant(1, { exp: Math.floor(Date.now() / 1000) - 1 }) }),
    );
    const grant = f.grant();
    const parts = grant.split(".");
    parts[0] = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "issuer" })).toString(
      "base64url",
    );
    await assert.rejects(f.host.bootstrap({ grant: parts.join(".") }));
    f.supervisor.config.projects = [];
    await assert.rejects(f.host.bootstrap({ grant: f.grant() }));
    assert.equal(f.calls.length, 0);
  } finally {
    f.host.close();
  }
});

test("lost heartbeat acknowledgement retries the identical signed request once and stays registered", async () => {
  const f = fixture();
  try {
    const initial = await f.host.bootstrap({ grant: f.grant() });
    let requests = 0;
    let previousBody;
    const acknowledgement = {
      registrationId: initial.registrationId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      sequence: 1,
      nonce: randomUUID(),
    };
    f.setHandler((_url, init) => {
      requests++;
      if (requests === 1) {
        previousBody = init.body;
        throw new Error("response lost after commit");
      }
      assert.equal(init.body, previousBody);
      return Response.json(acknowledgement);
    });
    await f.host.heartbeat();
    assert.equal(requests, 2);
    assert(f.host.isActive());
    assert.equal(f.host.currentRegistration().expiresAt, acknowledgement.expiresAt * 1000);
  } finally {
    f.host.close();
  }
});
test("heartbeat policy rejection never retries; repeated transport failure is bounded", async () => {
  for (const mode of ["policy", "transport"]) {
    const f = fixture();
    try {
      await f.host.bootstrap({ grant: f.grant() });
      let requests = 0;
      f.setHandler(() => {
        requests++;
        if (mode === "policy") return new Response(null, { status: 403 });
        throw new Error("network");
      });
      await f.host.heartbeat();
      assert.equal(requests, mode === "policy" ? 1 : 2);
      assert(!f.host.isActive());
    } finally {
      f.host.close();
    }
  }
});
