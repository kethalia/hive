import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import {
  createDeliveryGitHubCollector,
  githubCollectorProofPayload,
} from "../templates/ai-dev-k8s/scripts/delivery-github-collector.mjs";
import { createGitHubCollectionJournal } from "../templates/ai-dev-k8s/scripts/delivery-github-journal.mjs";

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "hive-github-collector-"));
  directories.push(directory);
  const key = generateKeyPairSync("ed25519"),
    projectId = randomUUID(),
    threadId = randomUUID();
  let registration = {
    id: randomUUID(),
    serverInstanceId: randomUUID(),
    expiresAt: Date.now() + 60000,
    threads: [{ projectId, threadId }],
  };
  const context = {
    projectId,
    preparationIntentId: randomUUID(),
    repositoryId: "123",
    revision: "a".repeat(40),
    leaseId: randomUUID(),
    leaseGeneration: 1,
  };
  const sent = [],
    helpers = [],
    input = {
      managerThreadId: threadId,
      taskId: randomUUID(),
      stepId: randomUUID(),
      requestId: randomUUID(),
    };
  let challengeHook = (x) => x,
    helperHook = () => {},
    snapshotHook = () => {};
  const options = {
    enabled: true,
    stateDirectory: directory,
    hiveOrigin: "https://hive.example.invalid",
    hostPrivateKeyPem: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    currentRegistration: () => registration,
    currentProjectContext: () => context,
    runHelper: async (target, timeout) => {
      helpers.push(target);
      assert.ok(timeout > 0 && timeout <= 60000);
      helperHook();
      return { fixture: "independent fixed helper snapshot" };
    },
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.equal(init.headers.Authorization, undefined);
      const value = JSON.parse(init.body),
        phase = url.endsWith("/challenge") ? "challenge" : "snapshot";
      assert.equal(
        verify(
          null,
          Buffer.from(githubCollectorProofPayload(phase, value)),
          key.publicKey,
          Buffer.from(value.proof, "base64url"),
        ),
        true,
      );
      sent.push({ url, value });
      if (phase === "snapshot") {
        snapshotHook(value);
        return Response.json({ evidenceIds: ["fixture-id"] });
      }
      return Response.json(
        challengeHook({
          schemaVersion: 1,
          action: "collect_github_evidence",
          id: value.requestId,
          nonce: "b".repeat(64),
          registrationId: registration.id,
          managerBindingId: randomUUID(),
          target: {
            schemaVersion: 1,
            providerRepositoryId: "123",
            providerAccountId: "456",
            fullName: "owner/repository",
            pullNumber: 1,
            expectedHeadSha: context.revision,
          },
          policyDigest: "c".repeat(64),
          expiresAt: Date.now() + 59000,
        }),
      );
    },
  };
  return {
    options,
    input,
    sent,
    helpers,
    context,
    setRegistration: (x) => {
      registration = x;
    },
    registration: () => registration,
    setChallengeHook: (x) => {
      challengeHook = x;
    },
    setHelperHook: (x) => {
      helperHook = x;
    },
    setSnapshotHook: (x) => {
      snapshotHook = x;
    },
  };
}
test("collector defaults off without loading credentials or invoking a helper", async () => {
  await assert.rejects(createDeliveryGitHubCollector({}).refresh({}), /disabled/);
});
test("actual fixed Python helper fails closed without workspace agent authority", () => {
  const module = new URL(
    "../templates/ai-dev-k8s/scripts/delivery-github-collector.mjs",
    import.meta.url,
  ).href;
  const code = `import {collectFixedGitHubSnapshot} from ${JSON.stringify(module)}; try { await collectFixedGitHubSnapshot({schemaVersion:1,providerRepositoryId:"123",providerAccountId:"456",fullName:"fixture/repo",pullNumber:1,expectedHeadSha:"${"a".repeat(40)}"},1000); process.exit(2); } catch(error) { if(error.message!=="github_collection_failed")process.exit(3); process.stdout.write("agent_authority_required"); }`;
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: process.env.PATH, HOME: "/tmp", NODE_ENV: "test" },
    }),
    "agent_authority_required",
  );
});
test("a failed exited helper never signals its reaped numeric process group", () => {
  const module = new URL(
    "../templates/ai-dev-k8s/scripts/delivery-github-collector.mjs",
    import.meta.url,
  ).href;
  const code = `import {collectFixedGitHubSnapshot} from ${JSON.stringify(module)};let signals=0;process.kill=()=>{signals++;};try{await collectFixedGitHubSnapshot({schemaVersion:1,providerRepositoryId:"123",providerAccountId:"456",fullName:"fixture/repo",pullNumber:1,expectedHeadSha:"${"a".repeat(40)}"},3000);process.exit(2);}catch(error){if(error.message!=="github_collection_failed"||signals)process.exit(3);process.stdout.write("no_post_exit_signal");}`;
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: process.env.PATH, HOME: "/tmp", NODE_ENV: "test" },
    }),
    "no_post_exit_signal",
  );
});
test("only a signed fixed-origin challenge can invoke the fixed helper and publish its snapshot", async () => {
  const f = fixture(),
    result = await createDeliveryGitHubCollector(f.options).refresh(f.input);
  assert.deepEqual(result, { evidenceIds: ["fixture-id"] });
  assert.deepEqual(
    f.sent.map((x) => x.url),
    [
      "https://hive.example.invalid/api/delivery/github-source/challenge",
      "https://hive.example.invalid/api/delivery/github-source",
    ],
  );
  assert.equal(f.helpers[0].providerRepositoryId, "123");
  assert.equal(f.sent[1].value.policyDigest, "c".repeat(64));
  assert.equal(f.sent[1].value.producer, undefined);
  assert.equal(f.sent[1].value.passed, undefined);
});
test("caller producer/status/target/policy/URL injection is rejected before any request", async () => {
  const f = fixture(),
    collector = createDeliveryGitHubCollector(f.options);
  for (const extra of [
    { producer: "trusted" },
    { passed: true },
    { target: {} },
    { policy: {} },
    { url: "https://evil.invalid" },
    { sourceContext: { revisionId: randomUUID(), version: 1, headSha: "b".repeat(40) } },
  ])
    await assert.rejects(collector.refresh({ ...f.input, ...extra }), /invalid/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.helpers.length, 0);
});

function sourceFixture() {
  const f = fixture();
  let source = { revisionId: randomUUID(), version: 1, headSha: "b".repeat(40) };
  f.options.sourceProtocol = 1;
  f.options.currentAcceptedSource = async (scope) => {
    assert.deepEqual(scope, {
      managerThreadId: f.input.managerThreadId,
      taskId: f.input.taskId,
      stepId: f.input.stepId,
      checkoutBinding: f.context,
    });
    return source;
  };
  f.setChallengeHook((c) => ({
    ...c,
    target: { ...c.target, expectedHeadSha: source?.headSha ?? f.context.revision },
  }));
  return {
    ...f,
    source: () => source,
    setSource: (value) => {
      source = value;
    },
  };
}
test("accepted output checks bind advanced source while the physical checkout remains at its base", async () => {
  const f = sourceFixture();
  await createDeliveryGitHubCollector(f.options).refresh(f.input);
  assert.equal(f.helpers[0].expectedHeadSha, "b".repeat(40));
  for (const { value } of f.sent) {
    assert.deepEqual(value.sourceContext, f.source());
    assert.deepEqual(value.checkoutBinding, f.context);
    assert.equal(value.checkoutBinding.revision, "a".repeat(40));
  }
});
test("source-aware collection requires a fixed callback and rejects malformed independent facts", async () => {
  const f = sourceFixture();
  assert.throws(
    () => createDeliveryGitHubCollector({ ...f.options, currentAcceptedSource: undefined }),
    /source_callback_required/,
  );
  for (const source of [
    undefined,
    {},
    { ...f.source(), version: 0 },
    { ...f.source(), executionAuthorized: true },
  ]) {
    f.setSource(source);
    await assert.rejects(
      createDeliveryGitHubCollector(f.options).refresh(f.input),
      /source_context_invalid/,
    );
  }
  assert.equal(f.sent.length, 0);
  assert.equal(f.helpers.length, 0);
});
test("source change during collection or its acknowledgement retains the snapshot and rejects stale success", async () => {
  for (const phase of ["helper", "ack"]) {
    const f = sourceFixture();
    const change = () =>
      f.setSource({ revisionId: randomUUID(), version: 2, headSha: "c".repeat(40) });
    if (phase === "helper") f.setHelperHook(change);
    else f.setSnapshotHook(change);
    await assert.rejects(
      createDeliveryGitHubCollector(f.options).refresh(f.input),
      /lifetime_changed/,
    );
    assert.equal(f.sent.length, phase === "helper" ? 1 : 2);
    assert.ok(
      readFileSync(join(f.options.stateDirectory, `${f.input.requestId}.json`), "utf8").includes(
        "snapshot",
      ),
    );
  }
});
test("a retained source snapshot cannot be relabeled or downgraded on retry", async () => {
  for (const change of ["version", "legacy"]) {
    const f = sourceFixture();
    f.setSnapshotHook(() => {
      throw new Error("lost_ack");
    });
    await assert.rejects(createDeliveryGitHubCollector(f.options).refresh(f.input), /lost_ack/);
    if (change === "version") f.setSource({ ...f.source(), revisionId: randomUUID(), version: 2 });
    else {
      delete f.options.sourceProtocol;
      delete f.options.currentAcceptedSource;
    }
    f.sent.length = 0;
    await assert.rejects(
      createDeliveryGitHubCollector(f.options).refresh(f.input),
      /journal_scope_conflict/,
    );
    assert.equal(f.sent.length, 0);
    assert.equal(f.helpers.length, 1);
  }
});
test("wrong source head/nonce/registration/expired challenge never invokes helper", async () => {
  for (const mutate of [
    (c) => ({ ...c, target: { ...c.target, expectedHeadSha: "f".repeat(40) } }),
    (c) => ({ ...c, nonce: "bad" }),
    (c) => ({ ...c, target: { ...c.target, pullNumber: -1 } }),
    (c) => ({ ...c, target: { ...c.target, fullName: "https://evil.invalid/repo" } }),
    (c) => ({ ...c, unexpected: true }),
    (c) => ({ ...c, expiresAt: String(c.expiresAt) }),
    (c) => ({ ...c, registrationId: randomUUID() }),
    (c) => ({ ...c, expiresAt: Date.now() - 1 }),
  ]) {
    const f = fixture();
    f.setChallengeHook(mutate);
    await assert.rejects(
      createDeliveryGitHubCollector(f.options).refresh(f.input),
      /challenge_invalid/,
    );
    assert.equal(f.helpers.length, 0);
    assert.equal(readdirSync(f.options.stateDirectory).length, 0);
  }
});
test("lease source or native lifetime changes during collection prevent publication", async () => {
  for (const change of ["source", "registration"]) {
    const f = fixture();
    f.setHelperHook(() => {
      if (change === "source") f.context.revision = "f".repeat(40);
      else f.setRegistration({ ...f.registration(), serverInstanceId: randomUUID() });
    });
    await assert.rejects(
      createDeliveryGitHubCollector(f.options).refresh(f.input),
      /lifetime_changed/,
    );
    assert.equal(f.sent.length, 1);
  }
});
test("cross-origin redirect, excess response and excess snapshot are never signed onward", async () => {
  const f = fixture();
  f.options.fetchImpl = async () =>
    new Response(null, { status: 302, headers: { Location: "https://evil.invalid" } });
  await assert.rejects(
    createDeliveryGitHubCollector(f.options).refresh(f.input),
    /request_rejected/,
  );
  const g = fixture();
  g.options.fetchImpl = async () =>
    new Response("x".repeat(65537), { headers: { "Content-Type": "application/json" } });
  await assert.rejects(createDeliveryGitHubCollector(g.options).refresh(g.input), /response_limit/);
  const h = fixture();
  h.options.runHelper = async () => ({ excessive: "x".repeat(1024 * 1024) });
  await assert.rejects(createDeliveryGitHubCollector(h.options).refresh(h.input), /snapshot_limit/);
  assert.equal(h.sent.length, 1);
});
test("stalled injected response and stalled cancellation cannot outlive the collector deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const f = fixture(),
      started = Promise.withResolvers();
    let cancelled = false;
    f.options.fetchImpl = async () =>
      new Response(
        new ReadableStream({
          pull() {
            started.resolve();
          },
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    const rejected = assert.rejects(
      createDeliveryGitHubCollector(f.options).refresh(f.input),
      /response_timeout/,
    );
    await started.promise;
    t.mock.timers.tick(10001);
    await rejected;
    assert.equal(cancelled, true);
    assert.equal(f.helpers.length, 0);
  } finally {
    t.mock.timers.reset();
  }
});
test("lost acknowledgement recovers exact snapshot bytes after restart and reauthorizes instead of returning a cache", async () => {
  const f = fixture();
  let lost = true;
  f.setSnapshotHook(() => {
    if (lost) {
      lost = false;
      throw new Error("lost reply");
    }
  });
  await assert.rejects(createDeliveryGitHubCollector(f.options).refresh(f.input), /lost reply/);
  assert.equal(f.helpers.length, 1);
  assert.deepEqual(await createDeliveryGitHubCollector(f.options).refresh(f.input), {
    evidenceIds: ["fixture-id"],
  });
  assert.equal(f.helpers.length, 1);
  assert.equal(f.sent.length, 3);
  assert.deepEqual(f.sent[1].value.snapshot, f.sent[2].value.snapshot);
  f.options.fetchImpl = async () => new Response(null, { status: 403 });
  await assert.rejects(
    createDeliveryGitHubCollector(f.options).refresh(f.input),
    /request_rejected/,
  );
});
test("journal tampering and another native lifetime cannot reuse a private request", async () => {
  const f = fixture();
  await createDeliveryGitHubCollector(f.options).refresh(f.input);
  f.setRegistration({ ...f.registration(), serverInstanceId: randomUUID() });
  await assert.rejects(createDeliveryGitHubCollector(f.options).refresh(f.input), /scope_conflict/);
  const g = fixture();
  await createDeliveryGitHubCollector(g.options).refresh(g.input);
  const path = join(g.options.stateDirectory, `${g.input.requestId}.json`),
    saved = JSON.parse(readFileSync(path, "utf8"));
  saved.state.snapshot = { forged: true };
  writeFileSync(path, JSON.stringify(saved));
  await assert.rejects(
    createDeliveryGitHubCollector(g.options).refresh(g.input),
    /journal_unavailable/,
  );
  assert.equal(g.sent.length, 2);
});
test("full retry journal retires only authenticated challenges beyond expiry grace", () => {
  const f = fixture();
  const journal = createGitHubCollectionJournal(
    f.options.stateDirectory,
    f.options.hostPrivateKeyPem,
  );
  const now = Date.now();
  const ids = Array.from({ length: 32 }, () => randomUUID());
  for (const [index, requestId] of ids.entries())
    journal.write(requestId, {
      requestId,
      contextDigest: "a".repeat(64),
      challengeValidated: true,
      challenge: { expiresAt: index < 30 ? now - 120000 : now + 60000 },
      snapshot: { preserved: index },
    });
  const pending = ids
    .slice(30)
    .map((id) => readFileSync(join(f.options.stateDirectory, `${id}.json`), "utf8"));
  const next = randomUUID();
  journal.write(next, {
    requestId: next,
    contextDigest: "b".repeat(64),
    challengeValidated: true,
    challenge: { expiresAt: now + 60000 },
  });
  assert.equal(readdirSync(f.options.stateDirectory).length, 3);
  for (const id of ids.slice(0, 30)) assert.equal(journal.read(id), null);
  assert.deepEqual(
    ids.slice(30).map((id) => readFileSync(join(f.options.stateDirectory, `${id}.json`), "utf8")),
    pending,
  );
});
test("full journal preserves unexpired and grace-period bytes, including lost acknowledgements", () => {
  const f = fixture();
  const journal = createGitHubCollectionJournal(
    f.options.stateDirectory,
    f.options.hostPrivateKeyPem,
  );
  const ids = Array.from({ length: 32 }, () => randomUUID());
  for (const [index, requestId] of ids.entries())
    journal.write(requestId, {
      requestId,
      contextDigest: "a".repeat(64),
      challengeValidated: true,
      challenge: { expiresAt: Date.now() + (index % 2 ? 60000 : -1000) },
      snapshot: { original: index },
    });
  const next = randomUUID();
  assert.throws(
    () =>
      journal.write(next, {
        requestId: next,
        contextDigest: "b".repeat(64),
        challengeValidated: true,
        challenge: { expiresAt: Date.now() + 60000 },
      }),
    /journal_unavailable/,
  );
  assert.equal(readdirSync(f.options.stateDirectory).length, 32);
  for (const [index, requestId] of ids.entries())
    assert.deepEqual(journal.read(requestId).snapshot, { original: index });
});
test("retirement retains every file when an expired candidate has an invalid MAC", () => {
  const f = fixture();
  const journal = createGitHubCollectionJournal(
    f.options.stateDirectory,
    f.options.hostPrivateKeyPem,
  );
  const ids = Array.from({ length: 32 }, () => randomUUID());
  for (const requestId of ids)
    journal.write(requestId, {
      requestId,
      contextDigest: "a".repeat(64),
      challengeValidated: true,
      challenge: { expiresAt: Date.now() - 120000 },
    });
  const path = join(f.options.stateDirectory, `${ids[31]}.json`);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.state.challenge.expiresAt--;
  writeFileSync(path, JSON.stringify(saved));
  const next = randomUUID();
  assert.throws(
    () => journal.write(next, { requestId: next, contextDigest: "b".repeat(64) }),
    /journal_unavailable/,
  );
  assert.equal(readdirSync(f.options.stateDirectory).length, 32);
});
test("legacy journal entries without a validated challenge receipt require inspection", () => {
  const f = fixture();
  const journal = createGitHubCollectionJournal(
    f.options.stateDirectory,
    f.options.hostPrivateKeyPem,
  );
  for (let n = 0; n < 32; n++) {
    const requestId = randomUUID();
    journal.write(requestId, {
      requestId,
      contextDigest: "a".repeat(64),
      challenge: { expiresAt: Date.now() - 120000 },
    });
  }
  const requestId = randomUUID();
  assert.throws(
    () => journal.write(requestId, { requestId, contextDigest: "a".repeat(64) }),
    /journal_unavailable/,
  );
  assert.equal(readdirSync(f.options.stateDirectory).length, 32);
});
test("an unexpected FIFO is rejected without waiting for a writer or removing state", () => {
  const f = fixture();
  const requestId = randomUUID();
  execFileSync("mkfifo", ["-m", "600", join(f.options.stateDirectory, `${requestId}.json`)]);
  // Subprocess deadline makes an accidental blocking open a bounded test failure.
  const module = new URL(
    "../templates/ai-dev-k8s/scripts/delivery-github-journal.mjs",
    import.meta.url,
  ).href;
  const code = `import {createGitHubCollectionJournal} from ${JSON.stringify(module)};const j=createGitHubCollectionJournal(${JSON.stringify(f.options.stateDirectory)},${JSON.stringify(f.options.hostPrivateKeyPem)});try{j.read(${JSON.stringify(requestId)});process.exit(2)}catch(e){if(e.message!=="github_journal_unavailable")process.exit(3)}`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { timeout: 3000 });
  assert.equal(readdirSync(f.options.stateDirectory).length, 1);
});
