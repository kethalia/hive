import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDeliverySourceStateClient,
  sourceStateClientProofPayload,
} from "../templates/ai-dev-k8s/scripts/delivery-source-state-client.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hive-source-state-client-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  mkdirSync(join(checkout, ".git"));
  const keys = generateKeyPairSync("ed25519");
  let ctx = {
    ownerId: randomUUID(),
    managerBindingId: randomUUID(),
    taskId: randomUUID(),
    registration: {
      id: randomUUID(),
      serverInstanceId: randomUUID(),
      expiresAt: Date.now() + 55000,
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
  const thread = randomUUID(),
    operationId = randomUUID(),
    revisionId = randomUUID(),
    nextRevision = randomUUID();
  let meta = {
    runtimeId: randomUUID(),
    runtimeGeneration: 2,
    admissionId: randomUUID(),
    admissionGeneration: 3,
    producerDigest: "b".repeat(64),
    checkoutIncarnation: randomUUID(),
    barrierGeneration: 0,
    metadataPins: Object.fromEntries(
      [
        ["checkout", checkout],
        ["git", join(checkout, ".git")],
      ].map(([name, path]) => {
        const stat = lstatSync(path, { bigint: true });
        return [name, { device: stat.dev.toString(), inode: stat.ino.toString() }];
      }),
    ),
    metadataPinsDigest: "c".repeat(64),
    metadataPolicyDigest: "d".repeat(64),
    namespaceReceiptDigest: "e".repeat(64),
  };
  let calls = [],
    afterFetch = () => {},
    mutate = (v) => v,
    historical = false;
  function response(input) {
    const observedAt = Date.now() - 1,
      acceptedSource = { revisionId, version: 1, headSha: "b".repeat(40) },
      admission = Object.fromEntries(
        [
          "runtimeId",
          "runtimeGeneration",
          "admissionId",
          "admissionGeneration",
          "producerDigest",
          "checkoutIncarnation",
          "barrierGeneration",
        ].map((k) => [k, meta[k]]),
      );
    return {
      schemaVersion: 1,
      action: "read_source_state",
      requestId: input.requestId,
      observedAt,
      expiresAt: Math.min(observedAt + 29000, input.expiresAt, ctx.registration.expiresAt),
      scope: {
        ownerId: ctx.ownerId,
        registrationId: ctx.registration.id,
        serverInstanceId: ctx.registration.serverInstanceId,
        managerThreadId: thread,
        managerBindingId: ctx.managerBindingId,
        checkoutBindingDigest: "f".repeat(64),
        checkoutBinding: ctx.checkoutBinding,
        taskId: input.taskId,
      },
      admission,
      metadata: {
        pins: meta.metadataPins,
        pinsDigest: meta.metadataPinsDigest,
        policyDigest: meta.metadataPolicyDigest,
        namespaceReceiptDigest: meta.namespaceReceiptDigest,
      },
      accepted: {
        operationId: input.operationId,
        sourceContext: acceptedSource,
        previousRevisionId: null,
        parentSha: ctx.checkoutBinding.revision,
        treeSha: "c".repeat(40),
        manifestDigest: "d".repeat(64),
        repositoryId: "123",
        providerAccountId: "456",
        fullName: "fixture/source",
        branch: `codex/delivery/${input.taskId}/${input.operationId}`,
        baseBranch: "main",
        pullRequestId: "900",
        pullNumber: 7,
        producingAttemptId: randomUUID(),
        stepId: randomUUID(),
        proofDigest: "e".repeat(64),
      },
      current: {
        sourceContext: historical
          ? { revisionId: nextRevision, version: 2, headSha: "c".repeat(40) }
          : acceptedSource,
        headSha: historical ? "c".repeat(40) : acceptedSource.headSha,
        version: historical ? 2 : 1,
        physicalBase: ctx.checkoutBinding.revision,
        branch: historical
          ? `codex/delivery/${input.taskId}/${randomUUID()}`
          : `codex/delivery/${input.taskId}/${input.operationId}`,
      },
      isCurrent: !historical,
      publicationAuthorized: false,
      executionAuthorized: false,
    };
  }
  const options = {
    enabled: true,
    hiveOrigin: "https://hive.example.invalid",
    hostPrivateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    currentContext: async (value) => {
      assert.equal(value, thread);
      return ctx;
    },
    authorizeMetadata: async () => structuredClone(meta),
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://hive.example.invalid/api/delivery/source-publication/state");
      assert.equal(init.redirect, "manual");
      assert.deepEqual(init.headers, { "Content-Type": "application/json" });
      const input = JSON.parse(init.body);
      assert.ok(
        verify(
          null,
          Buffer.from(sourceStateClientProofPayload(input)),
          keys.publicKey,
          Buffer.from(input.proof, "base64url"),
        ),
      );
      calls.push(input);
      const result = mutate(response(input));
      afterFetch();
      return Response.json(result);
    },
  };
  const clients = [];
  const make = (extra) => {
    const c = createDeliverySourceStateClient({ ...options, ...extra });
    clients.push(c);
    return c;
  };
  t.after(async () => {
    for (const c of clients) await c.close();
  });
  return {
    options,
    make,
    thread,
    operationId,
    revisionId,
    root,
    get calls() {
      return calls;
    },
    setContext: (v) => {
      ctx = { ...ctx, ...v };
    },
    get context() {
      return structuredClone(ctx);
    },
    setMetadata: (v) => {
      meta = { ...meta, ...v };
    },
    get metadata() {
      return structuredClone(meta);
    },
    historical: () => {
      historical = true;
    },
    changeResponse: (fn) => {
      mutate = fn;
    },
    onFetch: (fn) => {
      afterFetch = fn;
    },
  };
}
test("disabled client touches no credentials, filesystem, callbacks or network", async () => {
  const client = createDeliverySourceStateClient();
  await assert.rejects(client.readForApply("x", {}), /disabled/);
  await assert.rejects(client.readHistorical("x", {}), /disabled/);
  await client.close();
});
test("fixed signed read validates current accepted facts and returns no new permissions", async (t) => {
  const f = fixture(t),
    client = f.make(),
    result = await client.readForApply(f.thread, {
      operationId: f.operationId,
      revisionId: f.revisionId,
    });
  assert.equal(result.isCurrent, true);
  assert.equal(result.publicationAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(f.calls[0].taskId, f.context.taskId);
  assert.equal(f.calls[0].action, "read_source_state");
  assert.equal(result.admission.checkoutIncarnation, f.metadata.checkoutIncarnation);
});
test("historical reader stays distinct; historical output cannot be used for apply", async (t) => {
  const f = fixture(t),
    client = f.make(),
    oldTask = randomUUID();
  f.historical();
  const result = await client.readHistorical(f.thread, {
    taskId: oldTask,
    operationId: f.operationId,
  });
  assert.equal(result.scope.taskId, oldTask);
  assert.equal(result.isCurrent, false);
  assert.equal(result.executionAuthorized, false);
  await assert.rejects(
    client.readForApply(f.thread, { operationId: f.operationId }),
    /historical_not_applicable/,
  );
});
test("model cannot override current task, site, policy or producer in apply query", async (t) => {
  const f = fixture(t),
    client = f.make();
  for (const query of [
    { operationId: f.operationId, taskId: randomUUID() },
    { operationId: f.operationId, hiveOrigin: "https://evil.invalid" },
    { operationId: f.operationId, producer: {} },
    { operationId: f.operationId, revisionId: "bad" },
  ])
    await assert.rejects(client.readForApply(f.thread, query), /query_invalid/);
  assert.equal(f.calls.length, 0);
});
test("changed owner/physical binding/revision and fabricated permission bits are rejected", async (t) => {
  const f = fixture(t),
    client = f.make();
  for (const mutate of [
    (v) => ({ ...v, scope: { ...v.scope, ownerId: randomUUID() } }),
    (v) => ({
      ...v,
      scope: { ...v.scope, checkoutBinding: { ...v.scope.checkoutBinding, leaseId: randomUUID() } },
    }),
    (v) => ({
      ...v,
      accepted: {
        ...v.accepted,
        sourceContext: { ...v.accepted.sourceContext, revisionId: randomUUID() },
      },
    }),
    (v) => ({ ...v, executionAuthorized: true }),
  ]) {
    f.changeResponse(mutate);
    await assert.rejects(
      client.readForApply(f.thread, { operationId: f.operationId, revisionId: f.revisionId }),
      /source_state_/,
    );
  }
});
test("missing or changed current source cannot masquerade as applicable accepted output", async (t) => {
  const f = fixture(t),
    client = f.make();
  for (const mutate of [
    (v) => ({ ...v, current: { ...v.current, headSha: "f".repeat(40) } }),
    (v) => ({
      ...v,
      current: { ...v.current, sourceContext: { ...v.current.sourceContext, version: 2 } },
    }),
    (v) => ({ ...v, accepted: { ...v.accepted, parentSha: "f".repeat(40) } }),
  ]) {
    f.changeResponse(mutate);
    await assert.rejects(
      client.readForApply(f.thread, { operationId: f.operationId }),
      /chain_invalid/,
    );
  }
});
test("metadata/admission drift while HTTP is outstanding invalidates response", async (t) => {
  const f = fixture(t),
    client = f.make();
  f.onFetch(() => f.setMetadata({ runtimeGeneration: 3 }));
  await assert.rejects(
    client.readForApply(f.thread, { operationId: f.operationId }),
    /scope_changed/,
  );
});
test("stale or overlong fact freshness is rejected", async (t) => {
  const f = fixture(t),
    client = f.make();
  for (const mutate of [
    (v) => ({ ...v, expiresAt: Date.now() - 1 }),
    (v) => ({ ...v, expiresAt: v.observedAt + 30001 }),
    (v) => ({ ...v, observedAt: Date.now() + 1000 }),
  ]) {
    f.changeResponse(mutate);
    await assert.rejects(
      client.readForApply(f.thread, { operationId: f.operationId }),
      /response_stale/,
    );
  }
});
test("server errors and injected credential text are sanitized", async (t) => {
  const f = fixture(t);
  for (const fetchImpl of [
    async () => {
      throw new Error("sensitive fixture token");
    },
    async () => new Response("sensitive fixture token", { status: 403 }),
  ]) {
    const client = f.make({ fetchImpl });
    await assert.rejects(
      client.readForApply(f.thread, { operationId: f.operationId }),
      (error) =>
        /^source_state_[a-z0-9_]+$/.test(error.message) && !error.message.includes("token"),
    );
  }
});
test("stalled response and stalled cancellation finish within bounded deadline", async (t) => {
  const f = fixture(t);
  let cancelled = false;
  const client = f.make({
      timeoutMs: 50,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
              return new Promise(() => {});
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    }),
    start = Date.now();
  await assert.rejects(client.readForApply(f.thread, { operationId: f.operationId }), /timeout/);
  assert.ok(cancelled);
  assert.ok(Date.now() - start < 1000);
});
test("close aborts pending authority reads and future calls", async (t) => {
  const f = fixture(t),
    client = f.make({ currentContext: () => new Promise(() => {}) }),
    pending = client.readForApply(f.thread, { operationId: f.operationId });
  await client.close();
  await assert.rejects(pending, /timeout/);
  assert.throws(() => client.readForApply(f.thread, { operationId: f.operationId }), /closed/);
  assert.equal(f.calls.length, 0);
});
