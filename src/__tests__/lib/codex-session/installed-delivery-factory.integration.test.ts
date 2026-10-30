import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  expectedGuardianHostConfig,
  guardianConfigSha256,
} from "@/lib/codex-session/guardian-config.server";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { GuardianService } from "@/lib/codex-session/guardian-service.server";
import { lockProducerAdmission } from "@/lib/codex-session/guardian-store.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { DeliveryNativeSourceService } from "@/lib/delivery/native.server";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { DeliverySourceStateService } from "@/lib/delivery/source-state.server";
import { SourcePublicationTransport } from "@/lib/delivery/source-transport.server";
import {
  installedDeliveryHostFixture,
  metadataLaunch,
  sha,
} from "../../../../scripts/fixtures/installed-delivery-host.mjs";
import { createInstalledDeliveryRuntime } from "../../../../templates/ai-dev-k8s/scripts/codex-delivery-runtime.mjs";
import { GUARDIAN_CONTROLLER_POLICY_DIGEST } from "../../../../templates/ai-dev-k8s/scripts/codex-guardian-controller.mjs";
import { guardianFixture } from "./guardian-fixture";

const processFixture = vi.hoisted(() => ({ home: "", helper: "", groups: [] as number[] }));
// Test-only provider/home substitution at the process boundary. The factory,
// publisher/channel, protected Python runtime and apply/channel remain actual.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, argv, options] = args;
      const action =
        Array.isArray(argv) && argv.length === 2 && argv[0] === "-I"
          ? argv[1].endsWith("/delivery-source-worker.py")
            ? "publisher"
            : argv[1].endsWith("/delivery-source-apply-worker.py")
              ? "apply"
              : null
          : null;
      if (command !== "/usr/bin/python3" || !action) return actual.spawn(...args);
      if (!processFixture.home || !processFixture.helper)
        throw new Error("Fixture process scope missing");
      const child = actual.spawn(
        command,
        ["-I", "-B", processFixture.helper, action, processFixture.home],
        {
          ...options,
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            NODE_ENV: "test",
            HOME: processFixture.home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
          },
        },
      );
      if (child.pid) processFixture.groups.push(child.pid);
      return child;
    },
  };
});

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_delivery_test")
)
  throw new Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
const helper = resolve("scripts/fixtures/installed-delivery-material.py");
const observedPaths = [
  "src/__tests__/lib/codex-session/installed-delivery-factory.integration.test.ts",
  "src/__tests__/lib/codex-session/guardian-fixture.ts",
  "src/__tests__/lib/delivery/native-fixture.ts",
  "scripts/fixtures/installed-delivery-material.py",
  "scripts/fixtures/installed-delivery-host.mjs",
  ...[
    "codex-delivery-runtime.mjs",
    "codex-source-application.mjs",
    "codex-guardian-controller.mjs",
    "delivery-manager-adapter.mjs",
    "delivery-native-spool.mjs",
    "delivery-source-publisher.mjs",
    "delivery-source-state-client.mjs",
    "delivery-source-worker.py",
    "delivery-source-runtime.py",
    "delivery-source-broker.py",
    "delivery-source-provider.py",
    "delivery-source-apply-client.mjs",
    "delivery-source-apply-worker.py",
    "managed-source-apply.py",
    "managed-projects.py",
  ].map((name) => `templates/ai-dev-k8s/scripts/${name}`),
  ...[
    "guardian-service.server.ts",
    "guardian-store.server.ts",
    "guardian-application-store.server.ts",
    "guardian-config.server.ts",
  ].map((name) => `src/lib/codex-session/${name}`),
  ...[
    "manager.server.ts",
    "native.server.ts",
    "source-transport.server.ts",
    "source-state.server.ts",
    "source-publication.server.ts",
    "repository.ts",
  ].map((name) => `src/lib/delivery/${name}`),
];
const sourceHashes = () =>
  Object.fromEntries(observedPaths.map((path) => [path, sha(readFileSync(resolve(path)))]));
function python(action: string, home: string, input?: unknown) {
  return JSON.parse(
    execFileSync("/usr/bin/python3", ["-I", "-B", helper, action, home], {
      input: input === undefined ? undefined : JSON.stringify(input),
      encoding: "utf8",
      timeout: 15000,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        NODE_ENV: "test",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    }),
  );
}

function repositoryRevision(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

it.skipIf(!url)(
  "actual installed factory publishes, completes and applies accepted source before continuation through signed services",
  async () => {
    const hashesBefore = sourceHashes();
    // Clean staged-source exports deliberately have no Git metadata. Exact source
    // hashes still bind the proof; never invent a tested commit for that case.
    const baseRevisionAtStart = repositoryRevision();
    const home = mkdtempSync(join(tmpdir(), "hive-delivery-installed-"));
    processFixture.home = home;
    processFixture.helper = helper;
    processFixture.groups = [];
    let runtime: Awaited<ReturnType<typeof createInstalledDeliveryRuntime>> | undefined;
    let success = false;
    let cleanupError: unknown;
    let shutdownGroupsGone = false;
    const errors: string[] = [],
      requests: string[] = [];
    try {
      const material = python("setup", home);
      const f = await guardianFixture(db, {
        workspaceEnrollment: true,
        deliveryExecutionEnabled: true,
        physical: material,
        policyDigest: GUARDIAN_CONTROLLER_POLICY_DIGEST,
        namespaceReceiptDigest: ({ fixture, launch }) =>
          guardianDigest({
            serverInstanceId: fixture.serverInstanceId,
            metadataLaunch: metadataLaunch(fixture.project.id, launch, material),
            executionIdentity: { mode: "isolated" },
          }),
      });
      python("bind", home, f.context);
      vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
      vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "true");
      vi.stubEnv(
        "HIVE_GUARDIAN_APPROVED_PACKAGES_JSON",
        JSON.stringify(f.guardian.policy.packages),
      );
      const env = {
        HIVE_CODEX_MANAGER_MODEL: "gpt-6.1-sol",
        HIVE_CODEX_MANAGER_EFFORT: "low",
        HIVE_DELIVERY_MANAGER_ENABLED: "true",
        HIVE_DELIVERY_EXECUTION_ENABLED: "true",
        HIVE_GUARDIAN_SOURCE_APPLICATION_ENABLED: "true",
      };
      const config = expectedGuardianHostConfig(
        { ...f.host, projects: [] },
        f.guardian.sessionConfig,
        env,
      );
      const { projects: _projects, ...binding } = f.host;
      const service = new GuardianService(
        db,
        f.guardian.sessionConfig,
        f.guardian.policy,
        "19".repeat(32),
        { env, resolveWorkspace: async () => binding },
      );
      const manager = new DeliveryManagerService(db, { ...f.dependencies, progressionProtocol: 1 });
      const native = new DeliveryNativeSourceService(db, f.dependencies);
      const state = new DeliverySourceStateService(db, {
        reauthorize: f.dependencies.reauthorize,
        guardianPolicy: f.guardian.policy,
      });
      const artifacts = new Map<string, Buffer>();
      const source = new SourcePublicationTransport(
        db,
        {
          reauthorize: f.dependencies.reauthorize,
          lockProducerAdmission: (tx, scope) => lockProducerAdmission(tx, scope, f.guardian.policy),
          resolvePolicy: () => ({
            version: "factory-fixture-v1",
            authorName: "Hive",
            authorEmail: "codex@kethalia.com",
            baseBranch: "main",
            allowedPrefixes: ["src"],
            maxFiles: 5,
            maxFileBytes: 1024,
            maxBytes: 4096,
          }),
        },
        {
          writeAndVerify: async (key, bytes, digest) => {
            if (artifacts.has(key)) expect(artifacts.get(key)).toEqual(Buffer.from(bytes));
            artifacts.set(key, Buffer.from(bytes));
            return { objectKey: key, contentDigest: digest, size: bytes.length };
          },
        },
      );
      const fetchImpl = async (target: string | URL | Request, init?: RequestInit) => {
        const endpoint = new URL(String(target));
        expect(endpoint.origin).toBe(config.hiveOrigin);
        requests.push(endpoint.pathname);
        const body = JSON.parse(init?.body as string);
        try {
          let value: unknown;
          if (endpoint.pathname === "/api/codex-host/guardians")
            value = await service.execute(body);
          else if (endpoint.pathname === "/api/delivery/host") value = await manager.execute(body);
          else if (endpoint.pathname === "/api/delivery/native") value = await native.ingest(body);
          else if (endpoint.pathname === "/api/delivery/source-publication/policy")
            value = await source.policy(body);
          else if (endpoint.pathname === "/api/delivery/source-publication/challenge")
            value = await source.issue(body);
          else if (endpoint.pathname === "/api/delivery/source-publication")
            value = await source.publish(body);
          else if (endpoint.pathname === "/api/delivery/source-publication/state")
            value = await state.read(body);
          else if (endpoint.pathname === "/api/delivery/github-source/challenge")
            return Response.json({ error: "fixture_no_ci_provider" }, { status: 403 });
          else throw new Error("Unexpected fixture URL");
          return Response.json(value);
        } catch (error) {
          errors.push(`${endpoint.pathname}:${error instanceof Error ? error.message : "unknown"}`);
          throw error;
        }
      };
      const host = installedDeliveryHostFixture({
        f,
        home,
        material,
        config,
        configSha256: guardianConfigSha256(config),
        fetchImpl,
        inspect: () => python("inspect", home),
        diagnostics: errors,
      });
      runtime = await createInstalledDeliveryRuntime({
        config,
        home,
        ...host,
        registration: { currentRegistration: f.registration, onRevoked: () => () => {} },
        inspectManaged: async () => python("inspect", home),
        fetchImpl,
      });
      const observe = runtime.adapter.observe;
      if (!observe) throw new Error("Actual observer missing");
      const call = async (operation: string, payload: unknown) => {
        const result = await runtime!.adapter.handleToolCall({
          threadId: f.managerThreadId,
          turnId: f.parentTurnId,
          callId: randomUUID(),
          namespace: null,
          tool: "hive_delivery",
          arguments: { operation, payload },
        });
        return JSON.parse(result.contentItems[0].text);
      };
      const validationStepId = randomUUID();
      await call("create_task", {
        ...f.definition,
        steps: [
          {
            id: f.stepId,
            kind: "implement",
            criterionIds: ["C1"],
            requiredEvidenceKinds: ["check"],
          },
          {
            id: validationStepId,
            kind: "validate",
            criterionIds: ["C1"],
            requiredEvidenceKinds: ["check"],
          },
        ],
        dependencies: [{ stepId: validationStepId, dependsOnStepId: f.stepId }],
      });
      const claim = await call("claim_step", {
        taskId: f.taskId,
        stepId: f.stepId,
        expectedVersion: 0,
        requestedModel: "gpt-6.1-sol",
        requestedEffort: "low",
      });
      expect(claim.canRun).toBe(false);
      observe({
        method: "rawResponseItem/completed",
        params: {
          threadId: f.managerThreadId,
          turnId: f.parentTurnId,
          item: {
            type: "function_call",
            namespace: "collaboration",
            name: "spawn_agent",
            call_id: f.source.spawnCallId,
            arguments: JSON.stringify({ model: "gpt-6.1-sol", reasoning_effort: "low" }),
          },
        },
      });
      observe({
        method: "item/completed",
        params: {
          threadId: f.managerThreadId,
          turnId: f.parentTurnId,
          item: {
            type: "subAgentActivity",
            kind: "started",
            id: f.source.spawnCallId,
            agentThreadId: f.source.childThreadId,
            model: "gpt-6.1-sol",
            reasoningEffort: "low",
          },
        },
      });
      const operationId = randomUUID();
      const published = await call("publish_source", {
        operationId,
        paths: ["src/main.txt"],
        deletions: [],
        message: "feat: factory fixture",
        title: "feat: factory fixture",
        body: "Local provider double only",
      });
      expect(published.sourceContext.version).toBe(1);
      const target = published.sourceContext;
      writeFileSync(join(material.checkout, "src/main.txt"), "later dirty bytes must remain\n");
      expect(readFileSync(join(material.checkout, ".git/HEAD"), "utf8").trim()).toBe(
        material.revision,
      );
      // Explicit trusted CI producer double, separate from native command exit.
      // The collector's real provider remains unavailable in this local fixture.
      const evidenceId = randomUUID();
      await new DeliveryRepository(db, f.policy).recordEvidence(f.user.id, "fixture-ci", {
        id: evidenceId,
        stepId: f.stepId,
        remoteId: randomUUID(),
        kind: "check",
        status: "passed",
        verificationMode: "simulated",
        environment: "installed-factory-fixture",
        sourceSha: target.headSha,
        criterionIds: ["C1"],
        objectKey: `delivery/${f.user.id}/fixture/check.json`,
        contentDigest: "f".repeat(64),
        observedAt: new Date(Date.now() - 100),
      });
      await call("complete_step", {
        taskId: f.taskId,
        stepId: f.stepId,
        attemptId: claim.attemptId,
        expectedVersion: claim.version,
        leaseGeneration: claim.leaseGeneration,
        sourceSha: target.headSha,
        evidenceIds: [evidenceId],
        report: {
          summary: "Local factory publication",
          difficulty: "low",
          difficultyReason: "Fixture",
          issues: [],
          remainingUncertainty: "No actual native or provider",
          nextAction: "Validate",
        },
      });
      observe({
        method: "turn/completed",
        params: { threadId: f.managerThreadId, turn: { id: f.parentTurnId, status: "completed" } },
      });
      const deadline = Date.now() + 15000;
      while (!host.continuations.length && !host.entry.executionRevoked && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 20));
      expect(errors).toEqual([]);
      expect(host.entry.executionRevoked).toBeUndefined();
      expect(host.continuations).toHaveLength(1);
      expect(host.entry.sourceApplication.phase).toBe("released");
      expect(readFileSync(join(material.checkout, ".git/HEAD"), "utf8").trim()).toBe(
        target.headSha,
      );
      expect(readFileSync(join(material.checkout, "src/main.txt"), "utf8")).toBe(
        "later dirty bytes must remain\n",
      );
      const git = (object: string) =>
        execFileSync("/usr/bin/git", ["-C", material.checkout, "show", object], {
          encoding: "utf8",
          timeout: 5000,
          env: {
            PATH: "/usr/bin:/bin",
            NODE_ENV: "test",
            HOME: home,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
          },
        });
      expect(git(":README.md")).toBe("unrelated staged bytes\n");
      expect(git("HEAD:src/main.txt")).toBe("published fixture bytes\n");
      expect(readFileSync(join(material.checkout, "README.md"), "utf8")).toBe(
        "unrelated staged bytes\n",
      );
      expect(readFileSync(join(material.checkout, "untracked"), "utf8")).toBe("retain untracked\n");
      expect(readFileSync(join(material.checkout, "ignored.cache"), "utf8")).toBe(
        "retain ignored\n",
      );
      expect(
        (await db.deliverySourceApplication.findFirstOrThrow({ where: { ownerId: f.user.id } }))
          .phase,
      ).toBe("applied");
      expect(
        (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: claim.attemptId } })).quiescedAt,
      ).toBeNull();
      expect(artifacts.size).toBe(1);
      expect(
        JSON.parse(readFileSync(join(home, "provider-effects.json"), "utf8")).pullRequests,
      ).toBe(1);
      expect(requests).toContain("/api/delivery/source-publication/state");
      const hashesAfter = sourceHashes();
      expect(hashesAfter).toEqual(hashesBefore);
      if (process.env.HIVE_INSTALLED_DELIVERY_EVIDENCE_PATH) {
        const output = resolve(process.env.HIVE_INSTALLED_DELIVERY_EVIDENCE_PATH);
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(
          output,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              passed: true,
              baseRevisionAtStart,
              baseRevisionAtEnd: repositoryRevision(),
              testedSourcesCommitted: false,
              sourceStable: true,
              sources: hashesAfter,
              requestCounts: Object.fromEntries(
                [...new Set(requests)].map((path) => [
                  path,
                  requests.filter((value) => value === path).length,
                ]),
              ),
              source: {
                physicalBase: material.revision,
                accepted: target,
                locallyApplied: host.entry.acceptedSource,
              },
              sourceApplicationPhase: host.entry.sourceApplication.phase,
              continuationReceipts: host.continuations.length,
              physicalWriterHeld: true,
              kernelQuiescenceClaimed: false,
              worktreeAndStagedBytesRetained: true,
              actual: [
                "installed factory",
                "manager/native/source spool",
                "signed PostgreSQL services",
                "outer HMAC readers/application authority",
                "Python publisher/apply FD channels",
                "protected Git/managed receipts",
              ],
              fixtureDoubles: [
                "initial guardian enrollment/kernel identity",
                "native history/root/cohort/input inventory",
                "GitHub HTTP",
                "CI evidence producer/artifact storage",
                "next-root execution receipt",
              ],
              cloudRequests: 0,
              accountInference: false,
              provider: JSON.parse(readFileSync(join(home, "provider-effects.json"), "utf8")),
            },
            null,
            2,
          )}\n`,
        );
      }
      success = true;
    } finally {
      try {
        await runtime?.close();
      } catch (error) {
        errors.push(`shutdown:${error instanceof Error ? error.message : "unknown"}`);
        cleanupError = error;
      }
      const gone = processFixture.groups.every((pid) => {
        try {
          process.kill(-pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      });
      shutdownGroupsGone = gone;
      if (success && gone && !cleanupError) rmSync(home, { recursive: true, force: true });
      else
        console.error(
          `Retained local factory fixture: ${home}; groupsGone=${gone}; categories=${JSON.stringify(errors)}`,
        );
      processFixture.home = "";
    }
    expect(cleanupError).toBeUndefined();
    expect(shutdownGroupsGone).toBe(true);
  },
  30000,
);
