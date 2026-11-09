import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDeliverySourcePublisher,
  runFixedSourceWorker,
  sourcePublisherProofPayload,
} from "../templates/ai-dev-k8s/scripts/delivery-source-publisher.mjs";
import {
  createSourcePublisherJournal,
  sourceDigest,
} from "../templates/ai-dev-k8s/scripts/delivery-source-publisher-journal.mjs";

async function initializeGit(f) {
  rmSync(join(f.checkout, ".git"), { recursive: true, force: true });
  const git = (args) =>
    execFileSync("/usr/bin/git", args, {
      cwd: f.checkout,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: f.dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    })
      .toString()
      .trim();
  git(["init", "--template="]);
  mkdirSync(join(f.checkout, "src"));
  writeFileSync(join(f.checkout, "src/change.ts"), "base\n");
  git(["add", "src/change.ts"]);
  git([
    "-c",
    "user.name=Initial",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "test: initial",
  ]);
  f.setCurrent({
    checkoutBinding: { ...f.current.checkoutBinding, revision: git(["rev-parse", "HEAD"]) },
  });
  const metadata = await f.options.authorizeMetadata();
  for (const [key, path] of [
    ["checkout", f.checkout],
    ["git", join(f.checkout, ".git")],
  ]) {
    const stat = lstatSync(path, { bigint: true });
    metadata.metadataPins[key] = { device: stat.dev.toString(), inode: stat.ino.toString() };
  }
  f.setMetadata(metadata);
  writeFileSync(join(f.checkout, "src/change.ts"), "new sealed raw\n");
  const original = f.options.fetchImpl;
  f.options.fetchImpl = async (url, init) => {
    const response = await original(url, init);
    if (url.endsWith("/policy")) {
      const body = await response.json();
      body.parentSha = f.current.checkoutBinding.revision;
      return Response.json(body);
    }
    return response;
  };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "hive-source-publisher-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  mkdirSync(join(checkout, ".git"));
  const keys = generateKeyPairSync("ed25519"),
    pem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    stateDirectory = join(dir, "private");
  let current = {
    ownerId: randomUUID(),
    managerBindingId: randomUUID(),
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
    taskId: randomUUID(),
    stepId: randomUUID(),
    attemptId: randomUUID(),
    attemptLeaseGeneration: 2,
    checkoutPath: checkout,
  };
  const threadId = randomUUID(),
    admission = {
      runtimeId: randomUUID(),
      runtimeGeneration: 2,
      admissionId: randomUUID(),
      admissionGeneration: 3,
      producerDigest: "e".repeat(64),
      checkoutIncarnation: randomUUID(),
      barrierGeneration: 0,
    };
  const pins = Object.fromEntries(
    [
      ["checkout", checkout],
      ["git", join(checkout, ".git")],
    ].map(([key, path]) => {
      const stat = lstatSync(path, { bigint: true });
      return [key, { device: stat.dev.toString(), inode: stat.ino.toString() }];
    }),
  );
  let meta = {
    ...admission,
    metadataPins: pins,
    metadataPinsDigest: "b".repeat(64),
    metadataPolicyDigest: "c".repeat(64),
    namespaceReceiptDigest: "d".repeat(64),
  };
  const policy = {
    version: "fixture-v1",
    authorName: "Hive",
    authorEmail: "codex@kethalia.com",
    baseBranch: "main",
    allowedPrefixes: ["src"],
    maxFiles: 5,
    maxFileBytes: 1024,
    maxBytes: 4096,
  };
  const proposal = {
    operationId: randomUUID(),
    paths: ["src/change.ts"],
    deletions: [],
    message: "feat(source): local test",
    title: "feat(source): local test",
    body: "Synthetic local proof",
  };
  const manifest = {
      files: [
        {
          path: "src/change.ts",
          contentDigest: "f".repeat(64),
          size: 10,
          mode: "100644",
          blobSha: "c".repeat(40),
        },
      ],
      deletions: [],
    },
    target = {
      headSha: "b".repeat(40),
      treeSha: "d".repeat(40),
      manifestDigest: sourceDigest(manifest),
    };
  let calls = [],
    workerCalls = 0,
    lostAck = false,
    challengeFailure = false,
    heldMetadata = false,
    grant = null;
  const journalState = () =>
    JSON.parse(readFileSync(join(stateDirectory, `${proposal.operationId}.json`), "utf8")).state;
  const original = structuredClone(current);
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, "manual");
    assert.deepEqual(init.headers, { "Content-Type": "application/json" });
    const body = JSON.parse(init.body),
      phase = url.endsWith("/policy")
        ? "policy"
        : url.endsWith("/challenge")
          ? "challenge"
          : "publish";
    assert.ok(
      verify(
        null,
        Buffer.from(sourcePublisherProofPayload(phase, body)),
        keys.publicKey,
        Buffer.from(body.proof, "base64url"),
      ),
    );
    calls.push({ url, body, wire: init.body });
    if (phase === "policy")
      return Response.json({
        operationId: proposal.operationId,
        parentSha: original.checkoutBinding.revision,
        sourceVersion: 0,
        repositoryId: "123",
        providerAccountId: "456",
        fullName: "fixture/source",
        branch: `codex/delivery/${original.taskId}/${proposal.operationId}`,
        policy,
        policyDigest: sourceDigest(policy),
        expiresAt: Date.now() + 55000,
      });
    if (phase === "challenge") {
      assert.equal(journalState().challengeWire, init.body);
      if (challengeFailure) return Response.json({ error: "fixture unavailable" }, { status: 503 });
      const value = {
        schemaVersion: 1,
        action: "publish_source_revision",
        id: body.requestId,
        nonce: "a".repeat(64),
        expiresAt: Date.now() + 45000,
        registrationId: original.registration.id,
        ownerId: original.ownerId,
        managerBindingId: original.managerBindingId,
        checkoutBindingDigest: "f".repeat(64),
        taskId: original.taskId,
        stepId: original.stepId,
        attemptId: original.attemptId,
        operationId: proposal.operationId,
        sourceVersion: 0,
        parentSha: original.checkoutBinding.revision,
        cursorVersion: 1,
        nativeSequence: 2,
        leaseGeneration: 2,
        repositoryId: "123",
        providerAccountId: "456",
        fullName: "fixture/source",
        branch: `codex/delivery/${original.taskId}/${proposal.operationId}`,
        target,
        policy,
        policyDigest: sourceDigest(policy),
        admission,
      };
      if (!grant) grant = value;
      return Response.json(grant);
    }
    assert.equal(journalState().finalWire, init.body);
    if (lostAck) {
      lostAck = false;
      throw new Error("synthetic lost final ACK");
    }
    return Response.json({
      sourceContext: {
        revisionId: "11111111-1111-4111-8111-111111111111",
        version: 1,
        headSha: target.headSha,
      },
      inputSourceSha: original.checkoutBinding.revision,
      replayed: calls.filter((c) => c.url.endsWith("source-publication")).length > 1,
      current: current.attemptId === original.attemptId,
      executionAuthorized: false,
    });
  };
  const runWorker = async (start, exchange) => {
    workerCalls++;
    assert.equal(start.attemptLeaseGeneration, 2);
    assert.equal(start.scope.leaseGeneration, 1);
    assert.equal(start.scope.checkoutIncarnation, admission.checkoutIncarnation);
    assert.equal(start.policy.authorEmail, policy.authorEmail);
    await exchange("authorize", { action: "metadata" });
    const receipt = {
      operationId: proposal.operationId,
      phase: "prepared",
      commitSha: target.headSha,
      treeSha: target.treeSha,
      manifestDigest: target.manifestDigest,
      parentSha: original.checkoutBinding.revision,
      branch: `codex/delivery/${original.taskId}/${proposal.operationId}`,
      fixtureOnly: false,
      freshAcceptanceAuthority: false,
    };
    const cap = await exchange("prepared", {
      receipt,
      challenge: {
        operationId: proposal.operationId,
        policyDigest: sourceDigest(policy),
        manifest,
        target,
      },
    });
    assert.deepEqual(journalState().grant, cap);
    await exchange("authorize", { action: "publication" });
    return {
      receipt: { ...receipt, phase: "published" },
      readback: {
        observedAt: new Date().toISOString(),
        providerAccountId: "456",
        repositoryId: "123",
        fullName: "fixture/source",
        manifest,
        commit: {
          sha: target.headSha,
          treeSha: target.treeSha,
          parentSha: original.checkoutBinding.revision,
        },
        reference: { name: `refs/heads/${cap.branch}`, sha: target.headSha, type: "commit" },
        pullRequest: {
          id: "900",
          number: 7,
          headRepositoryId: "123",
          baseRepositoryId: "123",
          headRef: cap.branch,
          headSha: target.headSha,
          baseRef: "main",
          state: "open",
          draft: true,
        },
      },
    };
  };
  const options = {
    enabled: true,
    stateDirectory,
    hiveOrigin: "https://hive.example.invalid",
    hostPrivateKeyPem: pem,
    currentContext: async (value) => {
      assert.equal(value, threadId);
      return current;
    },
    authorizeMetadata: async () => {
      if (heldMetadata) throw new Error("metadata revoked");
      return meta;
    },
    fetchImpl,
    runWorker,
  };
  const publishers = [];
  let expectedHold = false;
  const make = (extra) => {
    const value = createDeliverySourcePublisher({ ...options, ...extra });
    publishers.push(value);
    return value;
  };
  t.after(async () => {
    for (const publisher of publishers) {
      if (expectedHold) await assert.rejects(publisher.close(), /source_worker_group_unresolved/);
      else await publisher.close();
    }
  });
  return {
    expectHold: () => {
      expectedHold = true;
    },
    dir,
    checkout,
    pem,
    options,
    make,
    threadId,
    proposal,
    manifest,
    target,
    admission,
    journalState,
    get calls() {
      return calls;
    },
    get workerCalls() {
      return workerCalls;
    },
    setCurrent: (value) => {
      current = { ...current, ...value };
    },
    get current() {
      return structuredClone(current);
    },
    setMetadata: (value) => {
      meta = { ...meta, ...value };
    },
    loseAck: () => {
      lostAck = true;
    },
    challengeFail: () => {
      challengeFailure = true;
    },
    revoke: () => {
      heldMetadata = true;
    },
  };
}

test("default disabled creates no state or authority callbacks", async () => {
  let touched = false;
  const publisher = createDeliverySourcePublisher({
    stateDirectory: "/impossible",
    currentContext: () => {
      touched = true;
    },
  });
  await assert.rejects(publisher.publish("x", {}), /disabled/);
  assert.equal(touched, false);
  await publisher.close();
});
test("seals scope and exact challenge/grant/final bytes before effects and accepts only server receipt", async (t) => {
  const f = fixture(t),
    publisher = f.make();
  const result = await publisher.publish(f.threadId, f.proposal);
  assert.equal(result.executionAuthorized, false);
  assert.equal(f.workerCalls, 1);
  assert.ok(f.journalState().grant);
  assert.ok(f.journalState().finalWire);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/challenge")).length, 2);
  assert.deepEqual(
    f.calls.filter((c) => c.url.endsWith("/challenge")).map((c) => c.wire),
    [f.journalState().challengeWire, f.journalState().challengeWire],
  );
});
test("lost final ACK restarts from exact wire despite source/task/attempt advancement, without worker or cached success", async (t) => {
  const f = fixture(t),
    first = f.make();
  f.loseAck();
  await assert.rejects(first.publish(f.threadId, f.proposal), /source_publisher_uncertain/);
  const wire = f.journalState().finalWire;
  await first.close();
  f.setCurrent({
    taskId: randomUUID(),
    stepId: randomUUID(),
    attemptId: randomUUID(),
    sourceContext: { revisionId: randomUUID(), version: 2, headSha: "c".repeat(40) },
  });
  const second = f.make();
  const result = await second.publish(f.threadId, f.proposal);
  assert.equal(result.replayed, true);
  assert.equal(result.current, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(f.workerCalls, 1);
  assert.equal(f.calls.at(-1).wire, wire);
  await second.publish(f.threadId, f.proposal);
  assert.equal(f.calls.at(-1).wire, wire);
  assert.equal(f.workerCalls, 1);
});
test("changed operation replay or stable writer identity never reuses old authority", async (t) => {
  const f = fixture(t),
    p = f.make();
  f.loseAck();
  await assert.rejects(p.publish(f.threadId, f.proposal));
  const before = f.calls.length;
  await assert.rejects(
    p.publish(f.threadId, { ...f.proposal, message: "fix(source): different" }),
    /replay_conflict/,
  );
  f.setCurrent({ checkoutBinding: { ...f.current.checkoutBinding, leaseId: randomUUID() } });
  await assert.rejects(p.publish(f.threadId, f.proposal), /replay_conflict/);
  assert.equal(f.calls.length, before);
});
test("fresh effects reject changed admission tuple and unverified metadata", async (t) => {
  const f = fixture(t),
    p = f.make({
      runWorker: async (start, exchange) => {
        f.setMetadata({ runtimeGeneration: 99 });
        return f.options.runWorker(start, exchange);
      },
    });
  await assert.rejects(p.publish(f.threadId, f.proposal), /metadata_changed/);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/challenge")).length, 0);
  assert.equal(f.journalState().finalWire, undefined);
});
test("model cannot override authority or propose protected paths", async (t) => {
  const f = fixture(t),
    p = f.make();
  for (const value of [
    { ...f.proposal, policy: {} },
    { ...f.proposal, url: "https://evil.invalid" },
    { ...f.proposal, paths: ["src/.git/config"] },
    { ...f.proposal, paths: ["../secret"] },
  ])
    await assert.rejects(p.publish(f.threadId, value), /proposal_invalid/);
  assert.equal(f.calls.length, 0);
});
test("server policy scope mismatch fails before private worker", async (t) => {
  const f = fixture(t),
    p = f.make({ fetchImpl: async () => Response.json({ policy: {}, repositoryId: "999" }) });
  await assert.rejects(p.publish(f.threadId, f.proposal), /policy_scope_changed/);
  assert.equal(f.workerCalls, 0);
});
test("journal serializes publishers and rejects hardlinked recovery files", async (t) => {
  const f = fixture(t),
    journal = createSourcePublisherJournal(f.options.stateDirectory, f.pem);
  const id = randomUUID(),
    state = { operationId: id, contextDigest: "a", proposalDigest: "b" };
  journal.write(id, state);
  assert.throws(() => createSourcePublisherJournal(f.options.stateDirectory, f.pem), /locked/);
  const file = join(f.options.stateDirectory, `${id}.json`),
    old = readFileSync(file);
  linkSync(file, join(f.dir, "linked"));
  assert.throws(() => journal.read(id));
  assert.deepEqual(readFileSync(file), old);
  journal.close();
});
test("fixed FD3 worker uses real Git preparation, then server denial kills/reaps without provider credential access", async (t) => {
  const f = fixture(t);
  await initializeGit(f);
  const originalFetch = f.options.fetchImpl;
  f.challengeFail();
  const publisher = f.make({
    runWorker: runFixedSourceWorker,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/policy")) {
        const response = await originalFetch(url, init),
          body = await response.json();
        body.parentSha = f.current.checkoutBinding.revision;
        return Response.json(body);
      }
      if (url.endsWith("/challenge")) return Response.json({ error: "denied" }, { status: 503 });
      return originalFetch(url, init);
    },
    workerTimeoutMs: 5000,
  });
  await assert.rejects(publisher.publish(f.threadId, f.proposal), /worker_uncertain/);
  assert.ok(f.journalState().challengeWire);
  assert.equal(f.journalState().grant, undefined);
  assert.equal(f.journalState().finalWire, undefined);
  assert.ok(
    readdirSync(join(f.options.stateDirectory, "broker", f.proposal.operationId, "operations"))
      .length === 1,
  );
});

test("actual worker deadline cancels hung parent metadata exchange and reaps before close", async (t) => {
  const f = fixture(t);
  await initializeGit(f);
  let calls = 0;
  const publisher = f.make({
    runWorker: runFixedSourceWorker,
    workerTimeoutMs: 300,
    authorizeMetadata: async () => {
      if (++calls >= 3) return new Promise(() => {});
      return f.options.authorizeMetadata();
    },
  });
  const start = Date.now();
  await assert.rejects(publisher.publish(f.threadId, f.proposal), /source_worker_uncertain/);
  await publisher.close();
  assert.ok(Date.now() - start < 2500);
  assert.ok(calls >= 3);
  assert.equal(f.journalState().grant, undefined);
  assert.equal(f.journalState().finalWire, undefined);
});
test("journal MAC/unknown file/capacity failures retain original unresolved bytes", async (t) => {
  const f = fixture(t),
    directory = f.options.stateDirectory,
    journal = createSourcePublisherJournal(directory, f.pem);
  let id;
  for (let i = 0; i < 32; i++) {
    id = randomUUID();
    journal.write(id, { operationId: id, contextDigest: "a", proposalDigest: "b" });
  }
  const files = readdirSync(directory),
    saved = Object.fromEntries(
      files
        .filter((v) => v.endsWith(".json"))
        .map((v) => [v, readFileSync(join(directory, v), "utf8")]),
    );
  const over = randomUUID();
  assert.throws(() =>
    journal.write(over, { operationId: over, contextDigest: "a", proposalDigest: "b" }),
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(saved).map((v) => [v, readFileSync(join(directory, v), "utf8")]),
    ),
    saved,
  );
  const file = join(directory, `${id}.json`),
    value = JSON.parse(readFileSync(file, "utf8"));
  value.state.proposalDigest = "tampered";
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  assert.throws(() => journal.read(id));
  writeFileSync(join(directory, "unknown.tmp"), "preserve", { mode: 0o600 });
  assert.throws(() => journal.read(id));
  assert.equal(readFileSync(join(directory, "unknown.tmp"), "utf8"), "preserve");
  journal.close();
});

test("untrusted HTTP redirect/large/empty-chunk responses fail closed with bounded sanitized errors", async (t) => {
  const f = fixture(t);
  for (const make of [
    () =>
      new Response("secret-provider-text", {
        status: 307,
        headers: { Location: "https://evil.invalid" },
      }),
    () => new Response("x".repeat(65537), { headers: { "Content-Type": "application/json" } }),
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array());
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  ]) {
    const publisher = f.make({ fetchImpl: async () => make() });
    await assert.rejects(
      publisher.publish(f.threadId, { ...f.proposal, operationId: randomUUID() }),
      (error) => /^source_[a-z0-9_]+$/.test(error.message) && !error.message.includes("secret"),
    );
    await publisher.close();
  }
  assert.equal(f.workerCalls, 0);
});
test("a second active call cannot bypass serialized effect callbacks", async (t) => {
  const f = fixture(t);
  let release;
  const publisher = f.make({
    currentContext: () =>
      new Promise((resolve) => {
        release = () => resolve(f.current);
      }),
  });
  const pending = publisher.publish(f.threadId, f.proposal);
  assert.throws(
    () => publisher.publish(f.threadId, { ...f.proposal, operationId: randomUUID() }),
    /busy/,
  );
  const closing = publisher.close();
  release();
  await assert.rejects(pending, /source_publisher_uncertain/);
  await closing;
});

test("post-close unknown process group is never signaled after leader reap", async () => {
  const original = process.kill;
  let probed = false,
    probes = 0,
    lateSignals = 0;
  process.kill = (pid, signal) => {
    if (pid < 0 && signal === 0) {
      probed = true;
      probes++;
      return true;
    }
    if (pid < 0 && signal === "SIGKILL" && probed) {
      lateSignals++;
      return true;
    }
    return original(pid, signal);
  };
  try {
    await assert.rejects(
      runFixedSourceWorker({}, async () => ({}), { timeoutMs: 2000 }),
      /source_worker_group_unresolved/,
    );
    assert.ok(probes > 0);
    assert.equal(lateSignals, 0);
  } finally {
    process.kill = original;
  }
});
test("unresolved helper group keeps publisher flock for outer guardian recovery", async (t) => {
  const f = fixture(t);
  f.expectHold();
  const publisher = f.make({
    runWorker: async () => {
      throw new Error("source_worker_group_unresolved");
    },
  });
  await assert.rejects(publisher.publish(f.threadId, f.proposal), /source_worker_group_unresolved/);
  await assert.rejects(publisher.close(), /source_worker_group_unresolved/);
  assert.throws(
    () => createSourcePublisherJournal(f.options.stateDirectory, f.pem),
    /source_publisher_locked/,
  );
  assert.throws(() => publisher.publish(f.threadId, f.proposal), /source_publisher_busy/);
});
