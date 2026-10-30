import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDeliveryStatusClient,
  deliveryStatusClientProofPayload,
} from "../templates/ai-dev-k8s/scripts/delivery-status-client.mjs";
import { statusResponse } from "./fixtures/delivery-status-response.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "hive-status-client-")),
    checkout = join(home, "checkout"),
    keys = generateKeyPairSync("ed25519"),
    thread = randomUUID();
  mkdirSync(join(checkout, ".git"), { recursive: true });
  const c = {
    ownerId: randomUUID(),
    managerBindingId: randomUUID(),
    taskId: randomUUID(),
    stepId: randomUUID(),
    attemptId: randomUUID(),
    attemptLeaseGeneration: 1,
    inputSourceSha: "a".repeat(40),
    sourceContext: null,
    registration: {
      id: randomUUID(),
      serverInstanceId: randomUUID(),
      expiresAt: Date.now() + 60000,
    },
    checkoutBinding: {
      projectId: randomUUID(),
      preparationIntentId: randomUUID(),
      repositoryId: "123",
      revision: "a".repeat(40),
      leaseId: randomUUID(),
      leaseGeneration: 1,
    },
    checkoutPath: checkout,
  };
  const m = {
    runtimeId: randomUUID(),
    runtimeGeneration: 1,
    admissionId: randomUUID(),
    admissionGeneration: 3,
    producerDigest: "a".repeat(64),
    checkoutIncarnation: randomUUID(),
    barrierGeneration: 0,
    metadataPins: Object.fromEntries(
      [
        ["checkout", checkout],
        ["git", join(checkout, ".git")],
      ].map(([key, path]) => {
        const v = lstatSync(path, { bigint: true });
        return [key, { device: String(v.dev), inode: String(v.ino) }];
      }),
    ),
    metadataPinsDigest: "b".repeat(64),
    metadataPolicyDigest: "c".repeat(64),
    namespaceReceiptDigest: "d".repeat(64),
  };
  const calls = [],
    clients = [];
  const options = {
    enabled: true,
    hiveOrigin: "https://hive.invalid",
    hostPrivateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    currentContext: () => c,
    authorizeMetadata: () => m,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://hive.invalid/api/delivery/host/status");
      assert.equal(init.redirect, "manual");
      const input = JSON.parse(init.body);
      assert(
        verify(
          null,
          Buffer.from(deliveryStatusClientProofPayload(input)),
          keys.publicKey,
          Buffer.from(input.proof, "base64url"),
        ),
      );
      calls.push(input);
      return Response.json(statusResponse(input, c.ownerId, m));
    },
  };
  t.after(async () => {
    await Promise.all(clients.map((v) => v.close()));
    rmSync(home, { recursive: true, force: true });
  });
  return {
    c,
    m,
    thread,
    calls,
    options,
    open(patch = {}) {
      const client = createDeliveryStatusClient({ ...options, ...patch });
      clients.push(client);
      return client;
    },
  };
}
test("default-off fixed factual status request derives claim and validates full producer scope", async (t) => {
  await assert.rejects(createDeliveryStatusClient().read(), /disabled/);
  const f = fixture(t),
    result = await f.open().read(f.thread);
  assert.equal(result.scope.attemptId, f.c.attemptId);
  assert.equal(result.cleanupAuthorized, false);
  assert.equal(result.evidence.requirementStatus, "held");
  assert.equal(f.calls.length, 1);
  assert(!("payload" in f.calls[0]));
});
test("wrong owner/current claim/source/admission and positive permission responses reject", async (t) => {
  const f = fixture(t);
  for (const mutate of [
    (v) => (v.scope.ownerId = randomUUID()),
    (v) => (v.scope.attemptId = randomUUID()),
    (v) => (v.scope.inputSourceSha = "b".repeat(40)),
    (v) => v.admission.barrierGeneration++,
    (v) => (v.metadata.pinsDigest = "0".repeat(64)),
    (v) => (v.executionAuthorized = true),
    (v) => (v.expiresAt = Date.now() - 1),
    (v) => (v.source.headSha = "b".repeat(40)),
    (v) => (v.evidence.extra = "untrusted"),
  ]) {
    const client = f.open({
      fetchImpl: async (_url, init) => {
        const value = statusResponse(JSON.parse(init.body), f.c.ownerId, f.m);
        mutate(value);
        return Response.json(value);
      },
    });
    await assert.rejects(client.read(f.thread), /unavailable/);
  }
});
test("post-response context/metadata changes and replaced checkout are rejected", async (t) => {
  for (const change of ["claim", "runtime", "checkout"]) {
    const f = fixture(t),
      client = f.open({
        fetchImpl: async (_url, init) => {
          const value = statusResponse(JSON.parse(init.body), f.c.ownerId, f.m);
          if (change === "claim") f.c.attemptId = randomUUID();
          if (change === "runtime") f.m.runtimeGeneration++;
          if (change === "checkout") {
            renameSync(f.c.checkoutPath, `${f.c.checkoutPath}-old`);
            mkdirSync(join(f.c.checkoutPath, ".git"), { recursive: true });
          }
          return Response.json(value);
        },
      });
    await assert.rejects(client.read(f.thread), /unavailable/);
  }
});
test("bounds redirects, oversized responses, stalled bodies and ignored abort callbacks", async (t) => {
  const f = fixture(t);
  for (const fetchImpl of [
    async () => new Response(null, { status: 302 }),
    async () => Response.json({ x: "x".repeat(32769) }),
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            return new Promise(() => {});
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    async () => new Promise(() => {}),
  ]) {
    const client = f.open({ fetchImpl, timeoutMs: 30 });
    await assert.rejects(client.read(f.thread), /unavailable/);
  }
  const client = f.open({ authorizeMetadata: () => new Promise(() => {}), timeoutMs: 30 });
  await assert.rejects(client.read(f.thread), /unavailable/);
});
test("close fences delayed guardian replies and waits bounded outstanding reads", async (t) => {
  const f = fixture(t);
  let enter, reply;
  const entered = new Promise((r) => (enter = r)),
    late = new Promise((r) => (reply = r));
  const client = f.open({
      authorizeMetadata: async () => {
        enter();
        await late;
        return f.m;
      },
    }),
    pending = client.read(f.thread);
  void pending.catch(() => {});
  await entered;
  await client.close();
  reply();
  await assert.rejects(pending, /unavailable/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(async () => client.read(f.thread), /unavailable/);
});
