import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import test from "node:test";
import { createAcceptanceClient } from "../templates/ai-dev-k8s/scripts/delivery-acceptance-client.mjs";

const canonical = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
function fixture(options = {}) {
  const keys = generateKeyPairSync("ed25519"),
    abort = new AbortController();
  let calls = 0;
  const context = {
    ownerId: randomUUID(),
    managerThreadId: "manager",
    registration: { id: randomUUID(), serverInstanceId: "native", expiresAt: Date.now() + 60000 },
    checkoutBinding: {
      projectId: randomUUID(),
      preparationIntentId: randomUUID(),
      repositoryId: "123",
      revision: "a".repeat(40),
      leaseId: randomUUID(),
      leaseGeneration: 1,
    },
  };
  const fetchImpl = async (url, input) => {
    calls++;
    assert.equal(url, "https://hive.invalid/api/delivery/host/acceptance");
    assert.equal(input.redirect, "error");
    const value = JSON.parse(input.body),
      { proof, ...unsigned } = value;
    assert.ok(
      verify(
        null,
        Buffer.from(
          `hive-delivery-acceptance-v1\nPOST\n/api/delivery/host/acceptance\n${canonical(unsigned)}`,
        ),
        keys.publicKey,
        Buffer.from(proof, "base64url"),
      ),
    );
    const result = {
      schemaVersion: 1,
      action: value.action,
      requestId: value.requestId,
      observedAt: Date.now(),
      expiresAt: value.expiresAt,
      ownerId: context.ownerId,
      projectId: context.checkoutBinding.projectId,
      preparationIntentId: context.checkoutBinding.preparationIntentId,
      registrationId: context.registration.id,
      serverInstanceId: context.registration.serverInstanceId,
      managerThreadId: context.managerThreadId,
      producer: { fixture: true },
      result: { phase: "pending" },
      executionAuthorized: false,
      publicationAuthorized: false,
      cleanupAuthorized: false,
    };
    options.mutate?.(context, result);
    if (options.delay) await options.delay;
    return Response.json(result);
  };
  return {
    context,
    abort,
    calls: () => calls,
    client: createAcceptanceClient({
      hiveOrigin: "https://hive.invalid",
      hostPrivateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
      currentContext: () => context,
      authorizeMetadata: options.metadata ?? (async () => ({ fixture: true })),
      fetchImpl,
      signal: abort.signal,
    }),
  };
}
test("fixed signed empty-payload read permits same registration heartbeat renewal", async () => {
  const f = fixture({ mutate: (c) => (c.registration.expiresAt += 30000) });
  assert.deepEqual(await f.client.request("read_acceptance_plan", {}), { phase: "pending" });
  assert.equal(f.calls(), 1);
});
test("foreign response or changed lease cannot become acceptance input", async () => {
  for (const mutate of [
    (_c, r) => (r.ownerId = randomUUID()),
    (c) => c.checkoutBinding.leaseGeneration++,
    (c) => (c.registration.id = randomUUID()),
    (_c, r) => (r.executionAuthorized = true),
  ]) {
    const f = fixture({ mutate });
    await assert.rejects(f.client.request("read_acceptance_plan", {}));
  }
});
test("model-selected fields and arbitrary operations are rejected before network", async () => {
  const f = fixture();
  await assert.rejects(f.client.request("claim_acceptance", { model: "other" }));
  await assert.rejects(f.client.request("turn/start", {}));
  assert.equal(f.calls(), 0);
});
test("revocation during metadata callback cannot later send a request", async () => {
  let release;
  const waiting = new Promise((r) => (release = r)),
    f = fixture({ metadata: () => waiting });
  const pending = f.client.request("read_acceptance_plan", {});
  f.abort.abort();
  await assert.rejects(pending);
  release({ fixture: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls(), 0);
});
test("revocation while response is pending rejects its late ACK", async () => {
  let release;
  const waiting = new Promise((r) => (release = r)),
    f = fixture({ delay: waiting });
  const pending = f.client.request("read_acceptance_plan", {});
  while (!f.calls()) await new Promise((r) => setImmediate(r));
  f.abort.abort();
  await assert.rejects(pending);
  release();
  await new Promise((r) => setImmediate(r));
});
