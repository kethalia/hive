import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { encrypt } from "@hive/auth";
import type { PrismaClient } from "@hive/db";
import {
  expectedGuardianHostConfig,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import {
  GUARDIAN_METADATA_POLICY_DIGEST,
  type GuardianCheckout,
  type GuardianPackagePin,
  type GuardianPolicy,
  type GuardianPreparation,
  type GuardianProducerScope,
  guardianDigest,
  preparationDigest,
} from "@/lib/codex-session/guardian-contracts";
import { GuardianAdmissionStore } from "@/lib/codex-session/guardian-store.server";
import type { ManagerDependencies } from "@/lib/delivery/manager.server";
import { taskIntentPayloadSchema } from "@/lib/projects/task-intents.server";
import { nativeFixture } from "../delivery/native-fixture";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
/** Storage-level fixture: explicit local owner/package policy; no cloud identity
 * or hardware attestation. Drives actual phase transitions BEFORE registration. */
export async function guardianFixture(
  db: PrismaClient,
  hooks: {
    deliveryExecutionEnabled?: boolean;
    workspaceEnrollment?: boolean;
    physical?: {
      revision: string;
      leaseId: string;
      leaseGeneration: number;
      checkoutIncarnation: string;
      checkoutIdentity: { device: string; inode: string };
      gitIdentity: { device: string; inode: string };
    };
    policyDigest?: string;
    namespaceReceiptDigest?: (value: {
      fixture: Awaited<ReturnType<typeof nativeFixture>>;
      launch: Awaited<ReturnType<GuardianAdmissionStore["reserveNativeLaunch"]>>;
    }) => string;
    beforeNativeFinalize?: (stage: {
      fixture: Awaited<ReturnType<typeof nativeFixture>>;
      store: GuardianAdmissionStore;
      runtimeId: string;
      admissionId: string;
    }) => Promise<void>;
    beforeNativeLaunch?: (stage: {
      store: GuardianAdmissionStore;
      ownerId: string;
      runtimeId: string;
      runtimeGeneration: number;
      preparation: GuardianPreparation;
      checkout: GuardianCheckout;
      bound: Awaited<ReturnType<GuardianAdmissionStore["bindCheckout"]>>;
    }) => Promise<void>;
  } = {},
) {
  const issuer = generateKeyPairSync("ed25519"),
    outer = generateKeyPairSync("ed25519");
  const encryptionKey = "19".repeat(32);
  const pin: GuardianPackagePin = {
    packageManifestSha256: "1".repeat(64),
    guardianElfSha256: "2".repeat(64),
    nodeSha256: "3".repeat(64),
    protocol: "guardian-v1" as const,
    policyDigest: hooks.policyDigest ?? "4".repeat(64),
    metadataPolicyDigest: GUARDIAN_METADATA_POLICY_DIGEST,
  };
  const policy: GuardianPolicy = { enabled: true, producerEnabled: true, packages: [pin] };
  const sessionConfig = {
    privateKeyPem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId: "guardian-fixture",
    hiveOrigin: "https://hive-fixture.invalid",
    softwareTemplateIds: [] as string[],
    appSlug: "codex-session",
    gatewayPort: 13341,
    cookieDomains: [],
  };
  const runtimeEnv = {
    HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
    HIVE_CODEX_MANAGER_EFFORT: "low",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
    ...(hooks.deliveryExecutionEnabled ? { HIVE_DELIVERY_EXECUTION_ENABLED: "true" } : {}),
  };
  const expectedConfigSha256 = (binding: Parameters<typeof expectedGuardianHostConfig>[0]) =>
    guardianConfigSha256(expectedGuardianHostConfig(binding, sessionConfig, runtimeEnv));
  const store = new GuardianAdmissionStore(db, { policy, encryptionKey, expectedConfigSha256 });
  let stage:
    | {
        runtime: Awaited<ReturnType<typeof store.reserveRuntime>>;
        enrolled: Awaited<ReturnType<typeof store.enroll>>;
        preparation: GuardianPreparation;
        prepared: Awaited<ReturnType<typeof store.prepare>>;
        checkout: GuardianCheckout;
        bound: Awaited<ReturnType<typeof store.bindCheckout>>;
        launch: Awaited<ReturnType<typeof store.reserveNativeLaunch>>;
      }
    | undefined;
  const f = await nativeFixture(db, randomUUID(), {
    physical: hooks.physical && {
      revision: hooks.physical.revision,
      leaseId: hooks.physical.leaseId,
      leaseGeneration: hooks.physical.leaseGeneration,
    },
    beforeRegister: async ({ user, host, context }) => {
      const row = await db.projectTaskIntent.findUniqueOrThrow({
        where: { id: context.preparationIntentId },
      });
      const hostRequest = {
        schemaVersion: 1 as const,
        projectId: context.projectId,
        repositoryId: context.repositoryId,
        expectedAccountId: "456",
        taskId: context.preparationIntentId,
        requestId: row.requestId,
        revision: context.revision,
        model: "gpt-6.1-sol",
        effort: "low",
        text: "Guardian storage synthetic task; no account inference",
      };
      const payload = taskIntentPayloadSchema.parse({
        ownerId: user.id,
        projectId: context.projectId,
        workspaceId: host.workspaceId,
        taskId: context.preparationIntentId,
        requestId: row.requestId,
        requestDigest: row.requestDigest,
        hostRequest,
      });
      const encrypted = encrypt(JSON.stringify(payload), encryptionKey);
      await db.projectTaskIntent.update({
        where: { id: row.id },
        data: {
          phase: "queued",
          status: undefined,
          ciphertext: Uint8Array.from(encrypted.ciphertext),
          iv: Uint8Array.from(encrypted.iv),
          authTag: Uint8Array.from(encrypted.authTag),
        },
      });
      const enrollmentBinding = hooks.workspaceEnrollment ? { ...host, projects: [] } : host;
      const configSha256 = expectedConfigSha256(enrollmentBinding);
      const runtime = await store.reserveRuntime(enrollmentBinding, {
        lifetimeId: randomUUID(),
        bindingDigest: hooks.workspaceEnrollment
          ? hash(
              JSON.stringify({
                schemaVersion: 1,
                configSha256,
                packageManifestSha256: pin.packageManifestSha256,
              }),
            )
          : "6".repeat(64),
        outerPublicKeyPem: outer.publicKey.export({ type: "spki", format: "pem" }).toString(),
        packageManifestSha256: pin.packageManifestSha256,
        guardianElfSha256: pin.guardianElfSha256,
        nodeSha256: pin.nodeSha256,
        policyDigest: pin.policyDigest,
        metadataPolicyDigest: pin.metadataPolicyDigest,
        configSha256,
      });
      const grant = {
        ownerId: user.id,
        runtimeId: runtime.id,
        id: randomUUID(),
        tokenDigest: hash(`fixture-enrollment:${randomUUID()}`),
        bindingDigest: "8".repeat(64),
        issuedAt: new Date(Date.now() - 100),
        expiresAt: new Date(Date.now() + 30000),
      };
      await store.sealGrant(grant);
      const enrolled = await store.enroll({
        ownerId: user.id,
        runtimeId: runtime.id,
        grantId: grant.id,
        tokenDigest: grant.tokenDigest,
        bindingDigest: grant.bindingDigest,
        consumptionDigest: "9".repeat(64),
      });
      const preparation: GuardianPreparation = {
        schemaVersion: 1,
        stage: "preparation",
        ownerId: host.ownerId,
        workspaceId: host.workspaceId,
        buildId: host.buildId,
        projectId: context.projectId,
        repositoryId: context.repositoryId,
        providerAccountId: "456",
        taskId: context.preparationIntentId,
        requestId: row.requestId,
        baseSha: context.revision,
        requestDigest: hash(JSON.stringify(payload.hostRequest)),
      };
      const prepared = await store.prepare({
        ownerId: user.id,
        runtimeId: runtime.id,
        runtimeGeneration: enrolled.generation,
        preparation,
        preparationDigest: preparationDigest(preparation),
      });
      const checkout: GuardianCheckout = {
        ...context,
        checkoutIncarnation: hooks.physical?.checkoutIncarnation ?? randomUUID(),
        checkoutIdentity: hooks.physical?.checkoutIdentity ?? { device: "123", inode: "456" },
      };
      const bound = await store.bindCheckout({
        ownerId: user.id,
        runtimeId: runtime.id,
        runtimeGeneration: prepared.runtime.generation,
        checkout,
      });
      await hooks.beforeNativeLaunch?.({
        store,
        ownerId: user.id,
        runtimeId: runtime.id,
        runtimeGeneration: prepared.runtime.generation,
        preparation,
        checkout,
        bound,
      });
      const nativeLaunchId = randomUUID();
      const launchIntentDigest = guardianDigest({
        runtimeId: runtime.id,
        runtimeGeneration: prepared.runtime.generation,
        nativeLaunchId,
        inventory: [
          {
            admissionId: bound.admission.id,
            admissionGeneration: bound.admission.generation,
            checkout,
          },
        ],
      });
      const launch = await store.reserveNativeLaunch({
        ownerId: user.id,
        runtimeId: runtime.id,
        runtimeGeneration: prepared.runtime.generation,
        nativeLaunchId,
        launchIntentDigest,
        projectIds: [context.projectId],
      });
      stage = { runtime, enrolled, preparation, prepared, checkout, bound, launch };
    },
  });
  if (!stage) throw new Error("Guardian fixture not initialized");
  await hooks.beforeNativeFinalize?.({
    fixture: f,
    store,
    runtimeId: stage.runtime.id,
    admissionId: stage.bound.admission.id,
  });
  const dependencies: ManagerDependencies = f.dependencies;
  dependencies.guardianPolicy = policy;
  const scope: GuardianProducerScope = {
    hiveUserId: f.user.id,
    registrationId: f.registration().id,
    workspaceId: f.host.workspaceId,
    buildId: f.host.buildId,
    serverInstanceId: f.serverInstanceId,
    managerThreadId: f.managerThreadId,
    projectId: f.context.projectId,
    preparationIntentId: f.context.preparationIntentId,
    repositoryId: f.context.repositoryId,
    leaseId: f.context.leaseId,
    leaseGeneration: f.context.leaseGeneration,
  };
  const metadata = {
    pins: {
      checkout: stage.checkout.checkoutIdentity,
      git: hooks.physical?.gitIdentity ?? { device: "123", inode: "789" },
    },
    namespaceReceiptDigest:
      hooks.namespaceReceiptDigest?.({ fixture: f, launch: stage.launch }) ?? "a".repeat(64),
    nativeLaunchId: stage.launch.nativeLaunchId,
    launchIntentDigest: stage.launch.launchIntentDigest,
    metadataPolicyDigest: pin.metadataPolicyDigest,
  };
  const finalized = await store.finalizeNative({
    scope,
    runtimeId: stage.runtime.id,
    runtimeGeneration: stage.prepared.runtime.generation,
    metadata,
  });
  await db.projectTaskIntent.update({
    where: { id: f.context.preparationIntentId },
    data: { phase: "running" },
  });
  return {
    ...f,
    guardian: {
      store,
      policy,
      sessionConfig,
      expectedConfigSha256,
      outer,
      issuer,
      ...stage,
      scope,
      metadata,
      finalized,
    },
  };
}

/** Two real staged project admissions in one first-native inventory. */
export async function guardianPairFixture(db: PrismaClient) {
  const { PrismaRegistrationStore } = await import("@/lib/codex-session/registration-store.server");
  const keys = generateKeyPairSync("ed25519"),
    outer = generateKeyPairSync("ed25519"),
    issuer = generateKeyPairSync("ed25519");
  const user = await db.user.create({
    data: {
      coderUrl: "https://guardian-pair.invalid",
      coderUserId: randomUUID(),
      username: "guardian-pair",
      email: "fixture@invalid",
    },
  });
  const projects = await Promise.all(
    ["123", "789"].map((repositoryId) =>
      db.deliveryProject.create({
        data: {
          ownerId: user.id,
          provider: "github",
          providerRepositoryId: repositoryId,
          providerAccountId: "456",
          fullName: `fixture/pair-${repositoryId}`,
        },
      }),
    ),
  );
  const binding = {
    coderOrigin: user.coderUrl,
    hiveUserId: user.id,
    ownerId: user.coderUserId,
    workspaceId: randomUUID(),
    buildId: randomUUID(),
    agentId: randomUUID(),
    templateId: randomUUID(),
    appOrigin: "https://guardian-pair-app.invalid",
    appId: randomUUID(),
    projects: projects.map((p) => ({ projectId: p.id, repositoryId: p.providerRepositoryId })),
  };
  const config = {
    privateKeyPem: issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId: "pair",
    hiveOrigin: "https://hive.invalid",
    softwareTemplateIds: [binding.templateId],
    appSlug: "codex-session",
    gatewayPort: 13341,
    cookieDomains: [],
  };
  const env = {
    HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
    HIVE_CODEX_MANAGER_EFFORT: "low",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
  };
  const expectedConfigSha256 = (b: Parameters<typeof expectedGuardianHostConfig>[0]) =>
    guardianConfigSha256(expectedGuardianHostConfig(b, config, env));
  const pin: GuardianPackagePin = {
    packageManifestSha256: "1".repeat(64),
    guardianElfSha256: "2".repeat(64),
    nodeSha256: "3".repeat(64),
    protocol: "guardian-v1",
    policyDigest: "4".repeat(64),
    metadataPolicyDigest: GUARDIAN_METADATA_POLICY_DIGEST,
  };
  const policy: GuardianPolicy = { enabled: true, producerEnabled: true, packages: [pin] },
    encryptionKey = "19".repeat(32);
  const store = new GuardianAdmissionStore(db, { policy, encryptionKey, expectedConfigSha256 });
  const runtime = await store.reserveRuntime(binding, {
    lifetimeId: randomUUID(),
    bindingDigest: "6".repeat(64),
    outerPublicKeyPem: outer.publicKey.export({ type: "spki", format: "pem" }).toString(),
    packageManifestSha256: pin.packageManifestSha256,
    guardianElfSha256: pin.guardianElfSha256,
    nodeSha256: pin.nodeSha256,
    policyDigest: pin.policyDigest,
    metadataPolicyDigest: pin.metadataPolicyDigest,
    configSha256: expectedConfigSha256(binding),
  });
  const grant = {
    ownerId: user.id,
    runtimeId: runtime.id,
    id: randomUUID(),
    tokenDigest: hash(randomUUID()),
    bindingDigest: hash(randomUUID()),
    issuedAt: new Date(Date.now() - 100),
    expiresAt: new Date(Date.now() + 30000),
  };
  await store.sealGrant(grant);
  await store.enroll({
    ownerId: user.id,
    runtimeId: runtime.id,
    grantId: grant.id,
    tokenDigest: grant.tokenDigest,
    bindingDigest: grant.bindingDigest,
    consumptionDigest: hash(randomUUID()),
  });
  let generation = 1;
  const entries = [];
  for (const project of projects) {
    const taskId = randomUUID(),
      requestId = randomUUID(),
      requestDigest = hash(randomUUID());
    const hostRequest = {
      schemaVersion: 1 as const,
      projectId: project.id,
      repositoryId: project.providerRepositoryId,
      expectedAccountId: "456",
      taskId,
      requestId,
      revision: "a".repeat(40),
      model: "gpt-6.1-sol",
      effort: "low",
      text: "Synthetic two-project native launch",
    };
    const payload = taskIntentPayloadSchema.parse({
      ownerId: user.id,
      projectId: project.id,
      workspaceId: binding.workspaceId,
      taskId,
      requestId,
      requestDigest,
      hostRequest,
    });
    const encrypted = encrypt(JSON.stringify(payload), encryptionKey);
    await db.projectTaskIntent.create({
      data: {
        id: taskId,
        ownerId: user.id,
        projectId: project.id,
        workspaceId: binding.workspaceId,
        requestId,
        requestDigest,
        repositoryId: project.providerRepositoryId,
        providerAccountId: "456",
        sourceSha: hostRequest.revision,
        phase: "queued",
        ciphertext: Uint8Array.from(encrypted.ciphertext),
        iv: Uint8Array.from(encrypted.iv),
        authTag: Uint8Array.from(encrypted.authTag),
      },
    });
    const preparation: GuardianPreparation = {
      schemaVersion: 1,
      stage: "preparation",
      ownerId: user.coderUserId,
      workspaceId: binding.workspaceId,
      buildId: binding.buildId,
      projectId: project.id,
      repositoryId: project.providerRepositoryId,
      providerAccountId: "456",
      taskId,
      requestId,
      baseSha: hostRequest.revision,
      requestDigest: hash(JSON.stringify(payload.hostRequest)),
    };
    const prepared = await store.prepare({
      ownerId: user.id,
      runtimeId: runtime.id,
      runtimeGeneration: generation,
      preparation,
      preparationDigest: preparationDigest(preparation),
    });
    generation = prepared.runtime.generation;
    const checkout: GuardianCheckout = {
      projectId: project.id,
      preparationIntentId: taskId,
      repositoryId: project.providerRepositoryId,
      revision: hostRequest.revision,
      leaseId: randomUUID(),
      leaseGeneration: 1,
      checkoutIncarnation: randomUUID(),
      checkoutIdentity: { device: "123", inode: String(100 + entries.length) },
    };
    const bound = await store.bindCheckout({
      ownerId: user.id,
      runtimeId: runtime.id,
      runtimeGeneration: generation,
      checkout,
    });
    entries.push({ project, checkout, bound, threadId: randomUUID() });
  }
  const inventory = [...entries]
    .sort((a, b) => a.project.id.localeCompare(b.project.id))
    .map((e) => ({
      admissionId: e.bound.admission.id,
      admissionGeneration: e.bound.admission.generation,
      checkout: e.checkout,
    }));
  const nativeLaunchId = randomUUID(),
    launchIntentDigest = guardianDigest({
      runtimeId: runtime.id,
      runtimeGeneration: generation,
      nativeLaunchId,
      inventory,
    });
  await store.reserveNativeLaunch({
    ownerId: user.id,
    runtimeId: runtime.id,
    runtimeGeneration: generation,
    nativeLaunchId,
    launchIntentDigest,
    projectIds: entries.map((e) => e.project.id),
  });
  const registrations = new PrismaRegistrationStore(db),
    registrationId = randomUUID(),
    serverInstanceId = randomUUID(),
    now = Math.floor(Date.now() / 1000),
    nativeGrantDigest = hash(randomUUID());
  const nativeGeneration = await registrations.reserve({
    grantId: registrationId,
    binding,
    expiresAt: now + 60,
  });
  await registrations.seal({
    grantId: registrationId,
    generation: nativeGeneration,
    grantDigest: nativeGrantDigest,
  });
  if (
    !(await registrations.consumeAndRegister({
      grantId: registrationId,
      grantDigest: nativeGrantDigest,
      expiresAt: now + 60,
      now,
      registration: {
        binding,
        serverInstanceId,
        protocolVersion: "0.165.0",
        threads: entries.map((e) => ({
          projectId: e.project.id,
          repositoryId: e.project.providerRepositoryId,
          threadId: e.threadId,
        })),
        hostPublicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        generation: nativeGeneration,
        registeredAt: now,
        expiresAt: now + 60,
      },
    }))
  )
    throw new Error("Pair registration failed");
  const inputs = entries.map((e, index) => ({
    runtimeId: runtime.id,
    runtimeGeneration: generation,
    scope: {
      hiveUserId: user.id,
      registrationId,
      workspaceId: binding.workspaceId,
      buildId: binding.buildId,
      serverInstanceId,
      managerThreadId: e.threadId,
      projectId: e.project.id,
      preparationIntentId: e.checkout.preparationIntentId,
      repositoryId: e.checkout.repositoryId,
      leaseId: e.checkout.leaseId,
      leaseGeneration: e.checkout.leaseGeneration,
    },
    metadata: {
      pins: {
        checkout: e.checkout.checkoutIdentity,
        git: { device: "123", inode: String(200 + index) },
      },
      namespaceReceiptDigest: "a".repeat(64),
      nativeLaunchId,
      launchIntentDigest,
      metadataPolicyDigest: pin.metadataPolicyDigest,
    },
  }));
  return { store, policy, runtime, entries, inputs };
}
