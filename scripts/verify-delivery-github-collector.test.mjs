import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import {
  createDeliveryGitHubCollector,
  githubCollectorProofPayload,
} from "../templates/ai-dev-k8s/scripts/delivery-github-collector.mjs";

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
  ])
    await assert.rejects(collector.refresh({ ...f.input, ...extra }), /invalid/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.helpers.length, 0);
});
test("wrong source head/nonce/registration/expired challenge never invokes helper", async () => {
  for (const mutate of [
    (c) => ({ ...c, target: { ...c.target, expectedHeadSha: "f".repeat(40) } }),
    (c) => ({ ...c, nonce: "bad" }),
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
