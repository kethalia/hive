import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  guardianCanonical as canonical,
  GUARDIAN_CONTROLLER_POLICY_DIGEST,
  openGuardianController,
} from "../templates/ai-dev-k8s/scripts/codex-guardian-controller.mjs";

const sha = (v) => createHash("sha256").update(v).digest("hex"),
  digest = (v) => sha(canonical(v));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "hive-guardian-controller-")),
    issuer = generateKeyPairSync("ed25519");
  const binding = {
    coderOrigin: "https://coder.invalid",
    hiveUserId: randomUUID(),
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    buildId: randomUUID(),
    templateId: randomUUID(),
    appOrigin: "https://app.invalid",
    appId: randomUUID(),
  };
  const config = {
    guardianEnabled: true,
    nativeIsolationEnabled: true,
    hiveOrigin: "https://hive.invalid",
    binding,
    port: 13341,
    issuerKeyId: "issuer",
    issuerPublicKeyPem: issuer.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const kernel = {
    pid: process.pid,
    startTime: "100",
    bootId: randomUUID(),
    executable: "/usr/bin/node",
    device: "1",
    inode: "2",
  };
  const startup = {
    schemaVersion: 1,
    type: "ready",
    phase: "open",
    nonce: Buffer.alloc(32).toString("base64url"),
    configSha256: "1".repeat(64),
    packageManifestSha256: "2".repeat(64),
    nodeSha256: "3".repeat(64),
    guardianSha256: "4".repeat(64),
    workerSha256: "5".repeat(64),
    port: config.port,
    lifetimeId: randomUUID(),
    bindingDigest: "6".repeat(64),
    generation: 1,
    ownershipDigest: "7".repeat(64),
    projects: [],
    workerIdentity: { ...kernel, parentPid: 10 },
    guardianIdentity: { ...kernel, pid: 10, parentPid: 9 },
    outerIdentity: { ...kernel, pid: 9, parentPid: 8 },
  };
  const calls = [],
    runtimeId = randomUUID(),
    admissionId = randomUUID();
  let packet,
    mode = "normal",
    generation = 1,
    admission,
    metadata;
  const options = {
    config,
    configSha256: startup.configSha256,
    home,
    stateDirectory: join(home, "outer"),
    packageManifestSha256: startup.packageManifestSha256,
    guardianElfSha256: startup.guardianSha256,
    nodeSha256: startup.nodeSha256,
    startupAttestation: () => structuredClone(startup),
    async fetchImpl(url, request) {
      assert.equal(url, "https://hive.invalid/api/codex-host/guardians");
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "manual");
      assert.deepEqual(request.headers, { "Content-Type": "application/json" });
      const { proof, ...body } = JSON.parse(request.body);
      assert(
        verify(
          null,
          Buffer.from(
            `hive-guardian-controller-v1\nPOST\n/api/codex-host/guardians\n${canonical(body)}`,
          ),
          packet.identity.outerPublicKeyPem,
          Buffer.from(proof, "base64url"),
        ),
      );
      calls.push(body);
      if (mode === "unknown") throw new Error("fixture_unknown_commit");
      if (mode === "redirect")
        return new Response(null, {
          status: 307,
          headers: { Location: "https://foreign.invalid" },
        });
      if (body.action === "enroll")
        return Response.json({ accepted: true, runtimeId, runtimeGeneration: 1 });
      if (body.action === "prepare") {
        generation = 2;
        admission = {
          id: admissionId,
          projectId: body.preparation.projectId,
          runtimeId,
          generation: 1,
          phase: "preparation",
          preparationDigest: body.preparationDigest,
          checkoutBinding: null,
          metadataPinsDigest: null,
        };
      }
      if (body.action === "checkout")
        admission = {
          ...admission,
          phase: "checkout",
          generation: 2,
          checkoutBinding: body.checkout,
        };
      if (body.action === "native") {
        metadata = body.metadata;
        admission = {
          ...admission,
          phase: "native",
          generation: 3,
          registrationId: body.registrationId,
          nativeThreadId: body.managerThreadId,
          metadataPinsDigest: digest(metadata),
        };
      }
      if (body.action === "metadata")
        return Response.json({
          runtimeId,
          runtimeGeneration: generation,
          admissionId,
          admissionGeneration: admission.generation,
          producerDigest: "f".repeat(64),
          checkoutIncarnation: admission.checkoutBinding.checkoutIncarnation,
          barrierGeneration: 0,
          metadataPins: metadata.pins,
          metadataPinsDigest: digest(metadata),
          metadataPolicyDigest: metadata.metadataPolicyDigest,
          namespaceReceiptDigest: metadata.namespaceReceiptDigest,
        });
      if (body.action === "launch")
        return Response.json({
          runtimeId,
          runtimeGeneration: generation,
          policyDigest: GUARDIAN_CONTROLLER_POLICY_DIGEST,
          metadataPolicyDigest: packet.identity.metadataPolicyDigest,
          nativeLaunchId: body.nativeLaunchId,
          launchIntentDigest: body.launchIntentDigest,
          approvals: [
            {
              projectId: admission.projectId,
              repositoryId: admission.checkoutBinding.repositoryId,
              taskId: admission.checkoutBinding.preparationIntentId,
              revision: admission.checkoutBinding.revision,
              leaseId: admission.checkoutBinding.leaseId,
              leaseGeneration: admission.checkoutBinding.leaseGeneration,
              checkoutIdentity: admission.checkoutBinding.checkoutIdentity,
              checkoutIncarnation: admission.checkoutBinding.checkoutIncarnation,
              admissionId,
              admissionGeneration: admission.generation,
              firstNative: true,
            },
          ],
        });
      return Response.json({
        runtime: { id: runtimeId, lifetimeId: startup.lifetimeId, phase: "open", generation },
        admission,
      });
    },
  };
  const client = openGuardianController(options);
  function identity() {
    packet = client.identity("a".repeat(64));
    return packet;
  }
  function grant(patch = {}) {
    const p = packet ?? identity(),
      now = Math.floor(Date.now() / 1000),
      head = Buffer.from(
        JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: config.issuerKeyId }),
      ).toString("base64url"),
      claims = {
        iss: config.hiveOrigin,
        aud: "hive:workspace-guardian",
        scope: "workspace:guardian:enroll",
        jti: randomUUID(),
        iat: now,
        exp: now + 60,
        runtimeId,
        hiveUserId: binding.hiveUserId,
        coderOwnerId: binding.ownerId,
        workspaceId: binding.workspaceId,
        agentId: binding.agentId,
        buildId: binding.buildId,
        appId: binding.appId,
        lifetimeId: startup.lifetimeId,
        outerKeyFingerprint: sha(
          createPublicKey(p.identity.outerPublicKeyPem).export({ type: "spki", format: "der" }),
        ),
        bindingDigest: startup.bindingDigest,
        identityDigest: digest({ identity: p.identity, binding: { ...binding, projects: [] } }),
        startupDigest: digest(p.startup),
        ...patch,
      },
      body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), issuer.privateKey).toString("base64url")}`;
  }
  function project(prepared = false) {
    const directory = join(home, ".local/state/hive/codex-project-controller");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const projectId = randomUUID(),
      request = {
        schemaVersion: 1,
        requestId: randomUUID(),
        repositoryId: "11",
        revision: "b".repeat(40),
        text: "PRIVATE_FIXTURE_PROMPT",
      },
      preparation = {
        schemaVersion: 1,
        stage: "preparation",
        ownerId: binding.ownerId,
        workspaceId: binding.workspaceId,
        buildId: binding.buildId,
        projectId,
        repositoryId: "11",
        providerAccountId: "12",
        taskId: randomUUID(),
        requestId: request.requestId,
        baseSha: request.revision,
        requestDigest: sha(JSON.stringify(request)),
      },
      task = {
        taskId: preparation.taskId,
        request,
        phase: "preparing",
        guardianPreparation: preparation,
      };
    const record = {
      schemaVersion: 1,
      preparationDigest: sha(JSON.stringify(preparation)),
      projectId,
      repositoryId: "11",
      taskId: task.taskId,
      revision: request.revision,
      leaseId: randomUUID(),
      leaseGeneration: 1,
      checkoutIncarnation: randomUUID(),
      checkoutIdentity: { device: "1", inode: "2" },
    };
    if (prepared) task.guardianPrepared = record;
    const state = {
      schemaVersion: 1,
      ownerId: binding.ownerId,
      workspaceId: binding.workspaceId,
      guardianLifetimeId: startup.lifetimeId,
      hostProcess: kernel,
      projects: { [projectId]: { projectId, repositoryId: "11", task } },
    };
    const key = Buffer.alloc(32, 13);
    writeFileSync(join(directory, "projects.key"), key, { mode: 0o600 });
    const save = () =>
      writeFileSync(
        join(directory, "projects.json"),
        JSON.stringify({
          state,
          signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
        }),
        { mode: 0o600 },
      );
    save();
    return { projectId, bindingDigest: sha(JSON.stringify(preparation)), state, save, record };
  }
  return {
    home,
    client,
    options,
    identity,
    grant,
    project,
    calls,
    startup,
    native(approval, projectId) {
      const directory = join(home, ".local/state/hive/codex-project-supervisor");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const a = approval.approvals[0],
        serverInstanceId = randomUUID(),
        key = Buffer.alloc(32, 14);
      const state = {
        status: "ready",
        buildId: binding.buildId,
        workspaceId: binding.workspaceId,
        hostProcess: kernel,
        serverInstanceId,
        controllerRegistration: { status: "registered", grantId: randomUUID() },
        projects: { [projectId]: { threadId: "fixture-native-root", serverInstanceId } },
        metadataLaunch: {
          phase: "started",
          approval,
          pins: {
            metadataPolicyDigest: packet.identity.metadataPolicyDigest,
            pins: [
              { projectId, checkout: a.checkoutIdentity, metadata: { device: "1", inode: "3" } },
            ],
          },
        },
        executionIdentity: { mode: "isolated" },
      };
      writeFileSync(join(directory, "key"), key, { mode: 0o600 });
      const save = () =>
        writeFileSync(
          join(directory, "registry.json"),
          JSON.stringify({
            state,
            signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
          }),
          { mode: 0o600 },
        );
      save();
      return { state, save };
    },
    mode: (v) => {
      mode = v;
    },
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

test("fresh nonce identity and one-use issuer grant use real Ed25519 domains and no bearer", async () => {
  const f = fixture();
  try {
    const p = f.identity(),
      { proof, ...body } = p;
    assert(
      verify(
        null,
        Buffer.from(`hive-guardian-identity-v1\n${canonical(body)}`),
        p.identity.outerPublicKeyPem,
        Buffer.from(proof, "base64url"),
      ),
    );
    assert.deepEqual(await f.client.bootstrap(f.grant()), {
      enrolled: true,
      runtimeId: f.calls[0].runtimeId,
    });
    await assert.rejects(f.client.bootstrap(f.grant()));
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});
test("foreign scope, unknown claims, expiry and startup changes cannot bootstrap", async () => {
  for (const patch of [{ workspaceId: randomUUID() }, { extra: true }, { exp: 1 }]) {
    const f = fixture();
    try {
      f.identity();
      await assert.rejects(f.client.bootstrap(f.grant(patch)));
      assert.equal(f.calls.length, 0);
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    f.identity();
    const grant = f.grant();
    f.startup.workerIdentity.inode = "999";
    await assert.rejects(f.client.bootstrap(grant));
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});
test("preparation and exact checkout precede fixed one-use native launch, no prompt forwarded", async () => {
  const f = fixture();
  try {
    f.identity();
    await f.client.bootstrap(f.grant());
    const p = f.project(true);
    const target = { projectId: p.projectId, bindingDigest: p.bindingDigest };
    assert.deepEqual(await f.client.authorizeAdmission(target), target);
    const approval = await f.client.metadataAuthority([{ projectId: p.projectId }]);
    assert.equal(approval.approvals[0].firstNative, true);
    assert.deepEqual(
      f.calls.map((c) => c.action),
      ["enroll", "prepare", "checkout", "fence", "fence", "launch"],
    );
    assert(!JSON.stringify(f.calls).includes("PRIVATE_FIXTURE_PROMPT"));
    await assert.rejects(f.client.metadataAuthority([{ projectId: p.projectId }]));
  } finally {
    f.close();
  }
});
test("HMAC-tampered and closed preparation journals never authorize a helper", async () => {
  const f = fixture();
  try {
    f.identity();
    await f.client.bootstrap(f.grant());
    const p = f.project();
    p.state.guardianBarrier = { closed: true };
    p.save();
    await assert.rejects(
      f.client.authorizeAdmission({ projectId: p.projectId, bindingDigest: p.bindingDigest }),
    );
    delete p.state.guardianBarrier;
    p.save();
    const path = join(f.home, ".local/state/hive/codex-project-controller/projects.json");
    const saved = JSON.parse(readFileSync(path));
    saved.state.projects[p.projectId].task.guardianPreparation.baseSha = "c".repeat(40);
    writeFileSync(path, JSON.stringify(saved));
    await assert.rejects(
      f.client.authorizeAdmission({ projectId: p.projectId, bindingDigest: p.bindingDigest }),
    );
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});
test("unknown commit or redirect durably holds, including reopen; never retries the operation", async () => {
  for (const mode of ["unknown", "redirect"]) {
    const f = fixture();
    try {
      f.identity();
      f.mode(mode);
      await assert.rejects(f.client.bootstrap(f.grant()));
      assert.equal(f.client.status.held, true);
      assert.throws(() => f.client.identity("a".repeat(64)));
      const reopened = openGuardianController(f.options);
      assert.throws(() => reopened.identity("b".repeat(64)));
      assert.equal(f.calls.length, 1);
    } finally {
      f.close();
    }
  }
});
test("private signer permission changes and absent idle authority fail closed", () => {
  const f = fixture();
  try {
    assert.throws(() => f.client.authorizeDrain());
    chmodSync(join(f.home, "outer/controller-key.pem"), 0o644);
    assert.throws(() => openGuardianController(f.options));
  } finally {
    f.close();
  }
});

test("registered native journal is freshly finalized and metadata revocation cannot use a cached receipt", async () => {
  const f = fixture();
  try {
    f.identity();
    await f.client.bootstrap(f.grant());
    const p = f.project(true),
      target = { projectId: p.projectId, bindingDigest: p.bindingDigest };
    await f.client.authorizeAdmission(target);
    const approval = await f.client.metadataAuthority([{ projectId: p.projectId }]),
      native = f.native(approval, p.projectId);
    const result = await f.client.currentMetadata(p.projectId);
    assert.deepEqual(result.metadataPins.git, { device: "1", inode: "3" });
    assert.deepEqual(
      f.calls.slice(-3).map((c) => c.action),
      ["native", "fence", "metadata"],
    );
    native.state.metadataLaunch.pins.pins[0].metadata.inode = "99";
    native.save();
    await assert.rejects(f.client.currentMetadata(p.projectId));
    assert.equal(f.client.status.held, true);
  } finally {
    f.close();
  }
});
