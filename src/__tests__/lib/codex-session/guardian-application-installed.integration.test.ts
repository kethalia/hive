import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  expectedGuardianHostConfig,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { guardianPost } from "@/lib/codex-session/guardian-route.server";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import {
  GUARDIAN_CONTROLLER_POLICY_DIGEST,
  guardianCanonical,
  openGuardianController,
} from "../../../../templates/ai-dev-k8s/scripts/codex-guardian-controller.mjs";
import { runApplyWorkerChannel } from "../../../../templates/ai-dev-k8s/scripts/delivery-source-apply-client.mjs";
import { guardianApplicationFixture } from "./guardian-application-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_delivery_test")
)
  throw new Error("Isolated local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const helper = resolve("scripts/fixtures/guardian-application-material.py");
const python = (action: string, home: string, input?: unknown) =>
  JSON.parse(
    execFileSync("/usr/bin/python3", ["-I", "-B", helper, action, home], {
      input: input === undefined ? undefined : JSON.stringify(input),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1048576,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" },
    }),
  );
type Material = {
  operationId: string;
  headSha: string;
  treeSha: string;
  manifestDigest: string;
  checkout: string;
  revision: string;
  leaseId: string;
  leaseGeneration: number;
  checkoutIncarnation: string;
  checkoutIdentity: { device: string; inode: string };
  gitIdentity: { device: string; inode: string };
};
const signedJournal = (
  home: string,
  name: string,
  file: string,
  keyName: string,
  state: unknown,
  key = Buffer.alloc(32, 13),
) => {
  const directory = join(home, ".local/state/hive", name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, keyName), key, { mode: 0o600 });
  writeFileSync(
    join(directory, file),
    JSON.stringify({
      state,
      signature: createHmac("sha256", key).update(JSON.stringify(state)).digest("hex"),
    }),
    { mode: 0o600 },
  );
};

/** Initial enrollment and terminal native history are explicit synthetic facts.
 * Actual behavior under test: signed GuardianService/PG actions, fixed protected
 * journal readers, private FD3 Python worker, real Git/index/managed receipts.
 * No native inference, cloud/provider request, cleanup or execution permission. */
describe.skipIf(!url)("protected source application composed with signed server authority", () => {
  it("applies actual sealed Git objects, retains worktree/staged bytes and reconciles lost commit ACK without rewriting", async () => {
    const home = mkdtempSync(join(tmpdir(), "hive-application-installed-"));
    const groups: number[] = [];
    let completed = false;
    const groupsGone = () =>
      groups.every((pid) => {
        try {
          process.kill(-pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      });
    try {
      const material = python("setup", home) as Material;
      const metadataLaunch = (projectId: string, approval: unknown) => ({
        phase: "started",
        approval,
        pins: {
          metadataPolicyDigest: "6401e70984f10dc9994a22563ccbdd9395947ddd9e69413463b097d7e18d539b",
          pins: [
            { projectId, checkout: material.checkoutIdentity, metadata: material.gitIdentity },
          ],
        },
      });
      const f = await guardianApplicationFixture(
        db,
        (policy) => {
          vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
          vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "true");
          vi.stubEnv(
            "HIVE_GUARDIAN_APPROVED_PACKAGES_JSON",
            JSON.stringify((policy as { packages: unknown }).packages),
          );
        },
        {
          ...material,
          guardian: {
            physical: material,
            policyDigest: GUARDIAN_CONTROLLER_POLICY_DIGEST,
            namespaceReceiptDigest: ({ fixture, launch }) =>
              guardianDigest({
                serverInstanceId: fixture.serverInstanceId,
                metadataLaunch: metadataLaunch(fixture.project.id, launch),
                executionIdentity: { mode: "isolated" },
              }),
          },
        },
      );
      const publication = await db.deliverySourceRevision.findUniqueOrThrow({
        where: { id: f.accepted.sourceContext.revisionId },
      });
      const scope = {
        ownerId: f.user.id,
        taskId: f.taskId,
        managerBindingId: f.claim.managerBindingId,
        attemptId: f.claim.attemptId,
        repositoryId: f.context.repositoryId,
        providerAccountId: f.project.providerAccountId,
        fullName: f.project.fullName,
        baseBranch: "main",
        parentSha: material.revision,
        sourceVersion: 0,
        serverInstanceId: f.serverInstanceId,
        leaseId: f.context.leaseId,
        leaseGeneration: f.context.leaseGeneration,
        checkoutIncarnation: material.checkoutIncarnation,
      };
      python("bind", home, { scope, checkoutBinding: f.context, branch: publication.branch });
      const env = {
        HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
        HIVE_CODEX_MANAGER_EFFORT: "low",
        HIVE_DELIVERY_MANAGER_ENABLED: "true",
        HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED: "true",
      };
      const config = expectedGuardianHostConfig(
          { ...f.host, projects: [] },
          f.guardian.sessionConfig,
          env,
        ),
        configSha256 = guardianConfigSha256(config);
      const { projects: _projects, ...binding } = f.host;
      const service = new GuardianService(
        db,
        f.guardian.sessionConfig,
        f.guardian.policy,
        "19".repeat(32),
        { env, resolveWorkspace: async () => binding },
      );
      const kernel = {
        pid: process.pid,
        startTime: "100",
        bootId: randomUUID(),
        executable: process.execPath,
        device: "1",
        inode: "2",
      };
      const startup = {
        phase: "open",
        configSha256,
        packageManifestSha256: f.guardian.runtime.packageManifestSha256,
        guardianSha256: f.guardian.runtime.guardianElfSha256,
        nodeSha256: f.guardian.runtime.nodeSha256,
        port: config.port,
        lifetimeId: f.guardian.runtime.lifetimeId,
        bindingDigest: f.guardian.runtime.bindingDigest,
        workerIdentity: { ...kernel, parentPid: 10 },
      };
      const hostRequest = {
        schemaVersion: 1,
        projectId: f.project.id,
        repositoryId: "123",
        expectedAccountId: "456",
        taskId: f.context.preparationIntentId,
        requestId: f.guardian.preparation.requestId,
        revision: material.revision,
        model: "gpt-6.1-sol",
        effort: "low",
        text: "Guardian storage synthetic task; no account inference",
      };
      expect(sha(JSON.stringify(hostRequest))).toBe(f.guardian.preparation.requestDigest);
      const claim = {
        managerThreadId: f.managerThreadId,
        parentTurnId: f.parentTurnId,
        attemptId: f.claim.attemptId,
        taskId: f.taskId,
        stepId: f.stepId,
        managerBindingId: f.claim.managerBindingId,
        registrationId: f.registration().id,
        serverInstanceId: f.serverInstanceId,
        checkoutBinding: f.context,
        checkoutBindingDigest: guardianDigest(f.context),
        inputSourceSha: material.revision,
      };
      const spool = {
        schemaVersion: 1,
        sourceProtocol: 1,
        progressionProtocol: 1,
        claims: { [f.managerThreadId]: claim },
        attempts: { [f.claim.attemptId]: claim },
        cursors: {
          [f.managerThreadId]: {
            attemptId: f.claim.attemptId,
            cursorVersion: 1,
            sequence: 2,
            acknowledgedSequence: 2,
          },
        },
        sourcePublications: {
          [f.claim.attemptId]: {
            operationId: f.operationId,
            sourceContext: f.accepted.sourceContext,
            parentSha: material.revision,
            previousRevisionId: null,
            treeSha: material.treeSha,
            manifestDigest: material.manifestDigest,
            proofDigest: publication.proofDigest,
          },
        },
        results: { [f.claim.attemptId]: { outcome: "succeeded" } },
        rootTurns: {
          [guardianDigest([f.managerThreadId, f.parentTurnId])]: {
            managerThreadId: f.managerThreadId,
            status: "completed",
          },
        },
        fragments: {
          fixtureChild: {
            managerThreadId: f.managerThreadId,
            attemptId: f.claim.attemptId,
            parentTurnId: f.parentTurnId,
            spawnCallId: f.source.spawnCallId,
            childThreadId: f.source.childThreadId,
            requested: { requestedModel: "gpt-6.1-sol", requestedEffort: "low" },
            resolved: { effectiveModel: "gpt-6.1-sol", effectiveEffort: "low" },
          },
        },
        events: [
          {
            acknowledged: true,
            managerThreadId: f.managerThreadId,
            input: {
              attemptId: f.claim.attemptId,
              source: { ...f.source, kind: "turn_completed", status: "completed" },
            },
          },
        ],
        violations: {},
        blocked: {},
      };
      const nativeKey = f.keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      const spoolRaw = JSON.stringify({
        state: spool,
        signature: createHmac("sha256", sha(`hive-native-spool-v1\n${nativeKey}`))
          .update(JSON.stringify(spool))
          .digest("hex"),
      });
      const spoolDirectory = join(home, ".local/state/hive/delivery-manager/native");
      mkdirSync(spoolDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(spoolDirectory, "source.json"), spoolRaw, { mode: 0o600 });
      const reserve = f.reservation(),
        routing = {
          receiveSequence: 17,
          pendingObservers: 0,
          activeHandlers: 0,
          observerFailures: [],
        },
        terminals = {
          projectId: f.project.id,
          closed: true,
          activeTerminals: 0,
          helpersPendingClose: 0,
          pendingInputs: 0,
          unknownInputs: 0,
        },
        cli = { projectId: f.project.id, activeCli: 0, unknownInputs: 0 };
      const {
        controllerJournalDigest: _c,
        supervisorJournalDigest: _s,
        ...barrier
      } = reserve.inputBarrier;
      const app = {
        projectId: f.project.id,
        applicationId: reserve.applicationId,
        publicationOperationId: f.operationId,
        targetSourceContext: f.accepted.sourceContext,
        expectedAppliedSourceContext: null,
        phase: "closing",
        serverInstanceId: f.serverInstanceId,
        managerThreadId: f.managerThreadId,
        cohort: [
          {
            parentTurnId: f.parentTurnId,
            spawnCallId: f.source.spawnCallId,
            childThreadId: f.source.childThreadId,
            childTurnId: f.source.childTurnId,
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
            effectiveModel: "gpt-6.1-sol",
            effectiveEffort: "low",
          },
        ],
        leaseExpiresAt: Math.floor(Date.now() / 1000) + 300,
        boundaryRequestDigest: sha("explicit synthetic terminal fixture"),
        reserveAttempted: true,
        barrier: {
          ...barrier,
          commandInventoryDigest: sha(JSON.stringify(routing)),
          terminalInventoryDigest: sha(JSON.stringify({ terminals, cli })),
          sourceSpoolDigest: sha(spoolRaw),
        },
        inputInventory: { terminals, cli, routing },
        boundary: {
          historyDigest: reserve.idleSnapshot.historyDigest,
          loadedInventoryDigest: reserve.idleSnapshot.loadedInventoryDigest,
          rootTurns: reserve.idleSnapshot.rootTurns,
          historyBytes: reserve.idleSnapshot.historyBytes,
          receiveSequence: 17,
        },
        idleSnapshot: reserve.idleSnapshot,
        sourceObservation: {
          scope: "native_observer_journal_only",
          ...claim,
          cursorVersion: 1,
          nativeSequence: 2,
          operationId: f.operationId,
          acceptedSourceContext: f.accepted.sourceContext,
          sourceJournalDigest: sha(spoolRaw),
          pendingSourceEvents: 0,
          unknownInputs: 0,
          writerHeld: true,
          quiescenceAuthority: false,
          metadataApplyAuthorized: false,
        },
      };
      const controllerTask = {
        taskId: f.context.preparationIntentId,
        phase: "running",
        request: hostRequest,
        guardianPreparation: f.guardian.preparation,
        sourceApplication: app,
        acceptedSource: null as unknown,
      };
      const controller = {
        schemaVersion: 1,
        ownerId: f.host.ownerId,
        workspaceId: f.host.workspaceId,
        guardianLifetimeId: f.guardian.runtime.lifetimeId,
        hostProcess: kernel,
        projects: {
          [f.project.id]: { projectId: f.project.id, repositoryId: "123", task: controllerTask },
        },
      };
      const nativeProject = {
        threadId: f.managerThreadId,
        serverInstanceId: f.serverInstanceId,
        sourceApplication: app,
        acceptedSource: null as unknown,
      };
      const native = {
        status: "ready",
        buildId: f.host.buildId,
        workspaceId: f.host.workspaceId,
        hostProcess: kernel,
        serverInstanceId: f.serverInstanceId,
        controllerPrivateKeyPem: nativeKey,
        controllerRegistration: { status: "registered", grantId: f.registration().id },
        projects: { [f.project.id]: nativeProject },
        metadataLaunch: metadataLaunch(f.project.id, f.guardian.launch),
        executionIdentity: { mode: "isolated" },
      };
      const sync = () => {
        signedJournal(
          home,
          "codex-project-controller",
          "projects.json",
          "projects.key",
          controller,
        );
        signedJournal(
          home,
          "codex-project-supervisor",
          "registry.json",
          "key",
          native,
          Buffer.alloc(32, 14),
        );
      };
      sync();
      const outerDirectory = join(home, "outer");
      mkdirSync(outerDirectory, { mode: 0o700 });
      writeFileSync(
        join(outerDirectory, "controller-key.pem"),
        f.guardian.outer.privateKey.export({ type: "pkcs8", format: "pem" }),
        { mode: 0o600 },
      );
      const identity = {
        lifetimeId: startup.lifetimeId,
        bindingDigest: startup.bindingDigest,
        outerPublicKeyPem: f.guardian.outer.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
        packageManifestSha256: startup.packageManifestSha256,
        guardianElfSha256: startup.guardianSha256,
        nodeSha256: startup.nodeSha256,
        policyDigest: GUARDIAN_CONTROLLER_POLICY_DIGEST,
        metadataPolicyDigest: f.guardian.runtime.metadataPolicyDigest,
        configSha256,
      };
      const state = {
        schemaVersion: 1,
        lifetimeId: startup.lifetimeId,
        identityDigest: guardianDigest(identity),
        runtimeId: f.guardian.runtime.id,
        generation: f.guardian.finalized.runtime.generation,
        projects: {
          [f.project.id]: {
            admissionId: f.guardian.finalized.admission.id,
            admissionGeneration: f.guardian.finalized.admission.generation,
            phase: "native",
            checkout: f.guardian.checkout,
            preparationDigest: f.guardian.finalized.admission.preparationDigest,
            metadataPinsDigest: f.guardian.finalized.admission.metadataPinsDigest,
          },
        },
        applications: {},
        launch: f.guardian.launch,
        pending: null,
        hold: false,
        sequence: 0,
        chainDigest: "0".repeat(64),
      };
      writeFileSync(
        join(outerDirectory, "controller.json"),
        JSON.stringify({
          state,
          signature: sign(
            null,
            Buffer.from(guardianCanonical(state)),
            f.guardian.outer.privateKey,
          ).toString("base64url"),
        }),
        { mode: 0o600 },
      );
      const actions: string[] = [];
      let loseCommit = true;
      let loseReserve = true;
      let driftAppliedReadback = false;
      const options = {
        config,
        configSha256,
        home,
        stateDirectory: outerDirectory,
        packageManifestSha256: startup.packageManifestSha256,
        guardianElfSha256: startup.guardianSha256,
        nodeSha256: startup.nodeSha256,
        startupAttestation: () => structuredClone(startup),
        fetchImpl: (async (url, request) => {
          expect(url).toBe(`${config.hiveOrigin}/api/codex-host/guardians`);
          const body = JSON.parse(request?.body as string);
          actions.push(body.action);
          const response = await guardianPost(new Request(url, request), () => service);
          if (response.status !== 200)
            throw new Error(
              `Fixture signed action rejected: ${body.action} status ${response.status}`,
            );
          if (body.action === "apply_reserve" && loseReserve) {
            loseReserve = false;
            throw new Error("fixture_lost_reserve_ack");
          }
          if (body.action === "apply_commit" && loseCommit) {
            loseCommit = false;
            throw new Error("fixture_lost_commit_ack");
          }
          if (
            body.action === "apply_verify" &&
            driftAppliedReadback &&
            (await response.clone().json()).phase === "applied"
          ) {
            driftAppliedReadback = false;
            writeFileSync(join(material.checkout, ".git/HEAD"), `${material.revision}\n`);
          }
          return response;
        }) satisfies typeof fetch,
      };
      let outer = openGuardianController(options);
      const request = {
        projectId: f.project.id,
        applicationId: app.applicationId,
        publicationOperationId: f.operationId,
        targetSourceContext: f.accepted.sourceContext,
        expectedAppliedSourceContext: null,
      };
      await expect(outer.applyReserve(request)).rejects.toThrow("fixture_lost_reserve_ack");
      outer = openGuardianController(options);
      const initial = await outer.applyReserve(request);
      expect(initial.phase).toBe("pending");
      const sourceState = () => ({
        scope: {
          ownerId: f.user.id,
          taskId: f.taskId,
          managerBindingId: f.claim.managerBindingId,
          serverInstanceId: f.serverInstanceId,
          checkoutBinding: f.context,
        },
        accepted: {
          operationId: f.operationId,
          producingAttemptId: f.claim.attemptId,
          sourceContext: f.accepted.sourceContext,
          repositoryId: "123",
          providerAccountId: "456",
          fullName: f.project.fullName,
          baseBranch: "main",
          parentSha: material.revision,
          manifestDigest: material.manifestDigest,
          treeSha: material.treeSha,
          branch: publication.branch,
        },
        admission: { checkoutIncarnation: material.checkoutIncarnation },
        current: { sourceContext: f.accepted.sourceContext, headSha: material.headSha },
        isCurrent: true,
        publicationAuthorized: false,
        executionAuthorized: false,
        expiresAt: Date.now() + 20000,
      });
      const bytes = () =>
        Object.fromEntries(
          ["src/main.txt", "README.md", "untracked", "ignored.cache"].map((p) => [
            p,
            readFileSync(join(material.checkout, p)).toString("base64"),
          ]),
        );
      const before = bytes();
      let commits = 0;
      const run = async () => {
        const child = spawn("/usr/bin/python3", ["-I", "-B", helper, "worker", home], {
          detached: true,
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" },
          stdio: ["ignore", "ignore", "pipe", "pipe"],
        });
        if (child.pid) groups.push(child.pid);
        let diagnostic = "";
        child.stderr?.on("data", (b) => {
          if (diagnostic.length < 8192) diagnostic += String(b);
        });
        try {
          return await runApplyWorkerChannel(
            child,
            {
              projectId: f.project.id,
              repositoryId: "123",
              applicationId: app.applicationId,
              publicationOperationId: f.operationId,
            },
            async (
              type: string,
              value: { expected: { currentSource: unknown }; sourceContext: unknown },
            ) => {
              expect(value.expected.currentSource).toBeNull();
              if (type === "authority") {
                const a = await outer.applyVerify({
                  projectId: f.project.id,
                  applicationId: app.applicationId,
                });
                const {
                  operationId,
                  sourceContext,
                  previousSourceContext,
                  parentSha,
                  treeSha,
                  manifestDigest,
                  metadataIdentity,
                  producer,
                  expiresAt,
                } = a;
                return {
                  authority: {
                    operationId,
                    sourceContext,
                    previousSourceContext,
                    parentSha,
                    treeSha,
                    manifestDigest,
                    metadataIdentity,
                    producer,
                    expiresAt,
                  },
                  sourceState: sourceState(),
                };
              }
              if (type === "input_barrier")
                return { closed: true, applicationId: app.applicationId };
              expect(type).toBe("applied");
              expect(python("inspect", home).acceptedSource).toEqual(f.accepted.sourceContext);
              app.phase = "applied";
              controllerTask.acceptedSource = value.sourceContext;
              nativeProject.acceptedSource = value.sourceContext;
              sync();
              const verified = await outer.applyVerify({
                projectId: f.project.id,
                applicationId: app.applicationId,
              });
              if (verified.phase !== "applied") {
                commits++;
                await outer.applyCommit({
                  projectId: f.project.id,
                  applicationId: app.applicationId,
                });
              }
              const final = await outer.applyVerify({
                projectId: f.project.id,
                applicationId: app.applicationId,
              });
              expect(final.phase).toBe("applied");
              expect(final.cleanupAuthorized).toBe(false);
              expect(final.executionAuthorized).toBe(false);
              return {
                committed: true,
                applicationId: app.applicationId,
                sourceContext: value.sourceContext,
              };
            },
            { timeoutMs: 15000 },
          );
        } catch (error) {
          if (diagnostic)
            throw new Error(`Fixture Python diagnostic: ${diagnostic}`, { cause: error });
          throw error;
        }
      };
      await expect(run()).rejects.toThrow();
      expect(
        (await db.deliverySourceApplication.findUniqueOrThrow({ where: { id: app.applicationId } }))
          .phase,
      ).toBe("applied");
      const files = [
        join(material.checkout, ".git/HEAD"),
        join(material.checkout, ".git/index"),
        join(home, ".local/state/hive/managed-projects/github-123.json"),
      ];
      const snapshot = () =>
        files.map((p) => ({
          sha: sha(readFileSync(p)),
          inode: statSync(p).ino,
          mtime: statSync(p).mtimeMs,
        }));
      // A server readback is factual, not permission to accept changed metadata.
      // Mutate only this fixture HEAD between signed response and outer acceptance.
      driftAppliedReadback = true;
      outer = openGuardianController(options);
      await expect(
        outer.applyVerify({ projectId: f.project.id, applicationId: app.applicationId }),
      ).rejects.toThrow();
      expect(outer.status.held).toBe(true);
      writeFileSync(files[0], `${material.headSha}\n`);
      const preserved = snapshot();
      outer = openGuardianController(options);
      expect((await run()).acceptedSource).toEqual(f.accepted.sourceContext);
      expect(snapshot()).toEqual(preserved);
      expect(bytes()).toEqual(before);
      expect(commits).toBe(1);
      expect(actions.filter((a) => a === "apply_reserve")).toHaveLength(1);
      expect(actions.filter((a) => a === "apply_commit")).toHaveLength(1);
      expect(
        execFileSync("/usr/bin/git", ["-C", material.checkout, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(material.headSha);
      expect(
        execFileSync("/usr/bin/git", ["-C", material.checkout, "show", ":README.md"], {
          encoding: "utf8",
        }),
      ).toBe("nonoverlapping staged edit\n");
      expect(
        (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.claim.attemptId } }))
          .quiescedAt,
      ).toBeNull();
      const beforeRevoked = snapshot();
      await db.codexHostRegistration.update({
        where: { id: f.registration().id },
        data: { revokedAt: new Date() },
      });
      await expect(
        outer.applyVerify({ projectId: f.project.id, applicationId: app.applicationId }),
      ).rejects.toThrow();
      expect(outer.status.held).toBe(true);
      expect(snapshot()).toEqual(beforeRevoked);
      expect(groupsGone()).toBe(true);
      completed = true;
    } finally {
      // No numeric group signal after reap. A failed proof or observable group
      // retains its private home for diagnosis instead of deleting live state.
      if (completed && groupsGone()) rmSync(home, { recursive: true, force: true });
      else process.stderr.write(`Fixture retained for independent review: ${home}\n`);
    }
  }, 45000);
});
