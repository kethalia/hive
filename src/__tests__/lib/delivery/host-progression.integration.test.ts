import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { PrismaRegistrationStore } from "@/lib/codex-session/registration-store.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { DeliveryRepository } from "@/lib/delivery/repository";
import { nativeFixture } from "./native-fixture";

const databaseUrl = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated loopback fixture required");
}
const db = new PrismaClient({
  datasourceUrl: databaseUrl ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(check: () => T | Promise<T>, code: string, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(20);
  }
  throw new Error(code);
}
const claimSchema = z.object({
  attemptId: z.string(),
  managerBindingId: z.string(),
  leaseGeneration: z.number(),
  version: z.number(),
  cursorVersion: z.number(),
  nativeSequence: z.number(),
  canRun: z.literal(false),
  needsRuntimeBinding: z.literal(true),
  needsReconciliation: z.literal(false),
  replayed: z.literal(false),
  outcome: z.literal("running"),
});
const fixtureReport = {
  summary: "Synthetic host progression",
  difficulty: "low",
  difficultyReason: "Local bounded fixture",
  issues: [],
  remainingUncertainty: "Simulated provider and check evidence only",
  nextAction: "Continue the held writer",
};
const outputMessage = (id: string) => ({
  id,
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "HIVE_HOST_PROGRESSION_DONE", annotations: [] }],
});
const outputTool = (id: string, name: string, args: unknown, namespace?: string) => ({
  id,
  type: "function_call",
  name,
  ...(namespace ? { namespace } : {}),
  call_id: id,
  arguments: JSON.stringify(args),
  status: "completed",
});
function stream(response: ServerResponse, id: string, item: unknown) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ])
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

describe.skipIf(!databaseUrl || process.env.HIVE_TEST_NATIVE_CODEX !== "1")(
  "canonical host/native/PG logical progression (synthetic provider only)",
  () => {
    it("automatically reports then completes two delegated steps across three root turns without releasing the writer", async () => {
      const output =
        process.env.HIVE_HOST_PROGRESSION_EVIDENCE_PATH ??
        "docs/checks/autonomous-delivery/manager-progression-local/host-native-pg.json";
      if (
        !resolve(output).startsWith(
          `${resolve("docs/checks/autonomous-delivery/manager-progression-local")}/`,
        ) ||
        !output.endsWith(".json")
      )
        throw new Error("Invalid test evidence path");
      const { openSupervisor, launchNative } = await import(
        pathToFileURL(resolve("templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs")).href
      );
      const { createDeliveryManagerAdapter } = await import(
        pathToFileURL(resolve("templates/ai-dev-k8s/scripts/delivery-manager-adapter.mjs")).href
      );
      const { processIdentity } = await import(
        pathToFileURL(resolve("templates/ai-dev-k8s/scripts/codex-process-identity.mjs")).href
      );
      const home = mkdtempSync(join(tmpdir(), "hive-host-pg-progression-"));
      const checkout = join(home, "projects/.hive-managed/github/123/checkout");
      mkdirSync(checkout, { recursive: true, mode: 0o700 });
      mkdirSync(join(home, ".codex"), { mode: 0o700 });
      const executable = realpathSync(
        process.env.HIVE_TEST_CODEX_EXECUTABLE ??
          "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
      );
      expect(hash(readFileSync(executable))).toBe(
        "c06a67fd8ac76508dc78bd99ce20c9f317b8d568beda59485f3f4134df9962d5",
      );
      const f = await nativeFixture(db),
        steps = [f.stepId, randomUUID(), randomUUID()];
      const manager = new DeliveryManagerService(db, { ...f.dependencies, progressionProtocol: 1 });
      const repository = new DeliveryRepository(db, f.policy);
      const definition = {
        ...f.definition,
        steps: steps.map((id, index) => ({
          id,
          kind: index === 0 ? "understand" : "validate",
          criterionIds: ["C1"],
          requiredEvidenceKinds: [index === 0 ? "analysis" : "check"],
        })),
        dependencies: [
          { stepId: steps[1], dependsOnStepId: steps[0] },
          { stepId: steps[2], dependsOnStepId: steps[1] },
        ],
      };
      let supervisor: Awaited<ReturnType<typeof openSupervisor>>;
      let adapter: ReturnType<typeof createDeliveryManagerAdapter>;
      let runtime: Awaited<ReturnType<typeof launchNative>>;
      let rootThreadId = "",
        stage = 0,
        providerCount = 0;
      let activeRegistration: ReturnType<typeof f.registration> | null = null;
      const replies = new Map<number, number>(),
        claims: z.infer<typeof claimSchema>[] = [],
        evidence = new Map<string, string>(),
        posts: { path: string; operation: unknown; source: unknown; sequence: unknown }[] = [],
        errors: string[] = [];
      const children: { threadId: string; spawnCallId: string }[] = [];
      const provider = createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404);
          response.end();
          return;
        }
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > 4 * 1024 * 1024) request.destroy();
        });
        request.on("end", () => {
          void (async () => {
            if (++providerCount > 20) throw new Error("provider_request_limit");
            const input = JSON.parse(body);
            const user = JSON.stringify(
              [...(input.input ?? [])]
                .reverse()
                .find((value: { role?: string }) => value.role === "user"),
            );
            const isChild =
              request.headers["x-codex-parent-thread-id"] === rootThreadId ||
              user?.includes("HIVE_MANAGER_CHILD");
            let item: ReturnType<typeof outputMessage> | ReturnType<typeof outputTool>;
            if (isChild) item = outputMessage(`child_${providerCount}`);
            else {
              const index = replies.get(stage) ?? 0;
              replies.set(stage, index + 1);
              const claim = claims[stage];
              if (stage === 0 && index === 0)
                item = outputTool("create_task", "hive_delivery", {
                  operation: "create_task",
                  payload: definition,
                });
              else if ((stage === 0 && index === 1) || (stage > 0 && index === 0))
                item = outputTool(`claim_${stage}`, "hive_delivery", {
                  operation: "claim_step",
                  payload: {
                    taskId: f.taskId,
                    stepId: steps[stage],
                    expectedVersion: 0,
                    requestedModel: "gpt-6.1-sol",
                    requestedEffort: "low",
                  },
                });
              else if (stage === 0 && index === 2)
                item = outputTool("report_understand", "hive_delivery", {
                  operation: "report_step",
                  payload: {
                    taskId: f.taskId,
                    stepId: steps[stage],
                    attemptId: claim.attemptId,
                    expectedVersion: claim.version,
                    leaseGeneration: claim.leaseGeneration,
                    sourceSha: f.context.revision,
                    report: fixtureReport,
                  },
                });
              else if (stage > 0 && index === 1)
                item = outputTool(
                  `spawn_${stage}`,
                  "spawn_agent",
                  {
                    task_name: `read_only_${stage}`,
                    message: "HIVE_MANAGER_CHILD: return the fixed marker, no tools or writes.",
                    model: "gpt-6.1-sol",
                    reasoning_effort: "low",
                    fork_turns: "none",
                  },
                  "collaboration",
                );
              else if (stage > 0 && index === 2) {
                await until(async () => {
                  const child = children.at(-1);
                  if (!child) return false;
                  const result = await runtime.call("thread/turns/list", {
                    threadId: child.threadId,
                    limit: 20,
                    itemsView: "full",
                    sortDirection: "asc",
                  });
                  return result.data.length === 1 && result.data[0].status === "completed";
                }, "child_not_completed");
                item = outputTool(`complete_${stage}`, "hive_delivery", {
                  operation: "complete_step",
                  payload: {
                    taskId: f.taskId,
                    stepId: steps[stage],
                    attemptId: claim.attemptId,
                    expectedVersion: claim.version,
                    leaseGeneration: claim.leaseGeneration,
                    sourceSha: f.context.revision,
                    evidenceIds: [evidence.get(steps[stage])],
                    report: fixtureReport,
                  },
                });
              } else item = outputMessage(`root_final_${stage}`);
            }
            stream(response, `fixture_${providerCount}`, item);
          })().catch((error) => {
            errors.push(error instanceof Error ? error.message : "provider_error");
            response.writeHead(503);
            response.end();
          });
        });
      });
      await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("provider_address_invalid");
      writeFileSync(
        join(home, ".codex/config.toml"),
        `model="gpt-6.1-sol"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="read-only"\nweb_search="disabled"\ncheck_for_update_on_startup=false\n[model_providers.fixture]\nname="Local mock only"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[features]\napps=false\nplugins=false\nhooks=false\nmemories=false\n`,
        { mode: 0o600 },
      );
      const sourcePaths = [
        "templates/ai-dev-k8s/scripts/delivery-manager-adapter.mjs",
        "templates/ai-dev-k8s/scripts/delivery-native-spool.mjs",
        "templates/ai-dev-k8s/scripts/codex-project-supervisor.mjs",
        "src/__tests__/lib/delivery/host-progression.integration.test.ts",
        "src/lib/delivery/manager.server.ts",
        "src/lib/delivery/progression.server.ts",
        "src/lib/delivery/repository.ts",
        "src/lib/delivery/contracts.ts",
        "src/lib/delivery/manager-contracts.ts",
        "src/lib/delivery/native-contracts.ts",
        "src/lib/delivery/native.server.ts",
        "src/lib/delivery/manager-binding.server.ts",
        "src/lib/codex-session/registration-store.server.ts",
        "src/__tests__/lib/delivery/native-fixture.ts",
        "packages/db/prisma/schema.prisma",
      ];
      const optionalSourcePaths = ["src/lib/delivery/source-resolver.server.ts"];
      sourcePaths.push(...optionalSourcePaths.filter((path) => existsSync(path)));
      const sourceDigests = Object.fromEntries(
        sourcePaths.map((path) => [path, hash(readFileSync(path))]),
      );
      const sourcesStable = () =>
        sourcePaths.every(
          (path) => existsSync(path) && hash(readFileSync(path)) === sourceDigests[path],
        ) && optionalSourcePaths.every((path) => existsSync(path) === path in sourceDigests);
      const proof: Record<string, unknown> = {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        baseRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sourceDigests,
        sourceStable: false,
        testedSourcesCommitted: !execFileSync(
          "git",
          ["status", "--porcelain", "--", ...sourcePaths],
          { encoding: "utf8" },
        ).trim(),
        nativeVersion: "0.165.0",
        runtimeSha256: hash(readFileSync(executable)),
        accountCredentials: false,
        accountInference: false,
        cloudMutations: false,
        passed: false,
        checks: {},
        limitations: [
          "Mocked Responses and simulated trusted fixture check evidence; not real CI or model inference.",
          "Injected signed local controller transport and managed checkout inspection; no production Coder callbacks or source advance.",
          "Physical anchor and unknown background/external writer state remain held; no cleanup/handoff/quiescence authority.",
          "Lost native start or historical claim replay retains a hold; runnable restart recovery is deliberately not accepted.",
        ],
      };
      let shutdownFailed = false;
      try {
        supervisor = await openSupervisor(
          {
            schemaVersion: 1,
            profile: "software",
            ownerId: f.host.ownerId,
            workspaceId: f.host.workspaceId,
            buildId: f.host.buildId,
            codexExecutable: executable,
            codexSha256: hash(readFileSync(executable)),
            executionMode: "direct",
            projects: [
              {
                projectId: f.project.id,
                repositoryId: "123",
                taskId: f.context.preparationIntentId,
                leaseId: f.context.leaseId,
                leaseGeneration: 1,
                model: "gpt-6.1-sol",
                effort: "low",
              },
            ],
          },
          {
            home,
            runtimeFactory: async (args: Parameters<typeof launchNative>[0]) => {
              runtime = await launchNative(args);
              runtime.inspectLease = () => ({
                ok: true,
                data: {
                  status: "ready",
                  checkoutVerified: true,
                  checkoutDirectory: checkout,
                  revision: f.context.revision,
                  lease: {
                    id: f.context.leaseId,
                    taskId: f.context.preparationIntentId,
                    generation: 1,
                    expiresAt: Date.now() / 1000 + 120,
                  },
                },
              });
              return runtime;
            },
          },
        );
        adapter = createDeliveryManagerAdapter({
          enabled: true,
          nativeEnabled: true,
          progressionProtocol: 1,
          hiveOrigin: "https://fixture-hive.invalid",
          stateDirectory: join(home, "manager-journal"),
          hostPrivateKeyPem: f.keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
          currentRegistration: () => activeRegistration,
          currentServerInstanceId: () => supervisor.state.serverInstanceId,
          currentProjectContext: () => f.context,
          registerChild: (manager: string, child: string, call: string) => {
            supervisor.registerChild(manager, child, call);
            if (!children.some((value) => value.threadId === child))
              children.push({ threadId: child, spawnCallId: call });
          },
          readNativeHistory: (request: unknown) => supervisor.readNativeHistory(request),
          drainNativeRouting: (options: unknown) => runtime.drainManagerRouting(options),
          continueRoot: async (request: { cursorVersion: number }) => {
            stage = request.cursorVersion;
            return supervisor.continueDeliveryRoot(request);
          },
          revalidateBoundary: (request: unknown, next: string, call: unknown) =>
            supervisor.revalidateDeliveryBoundary(request, next, call),
          fetchImpl: async (url: string, init: RequestInit) => {
            const path = new URL(url).pathname;
            if (
              new URL(url).origin !== "https://fixture-hive.invalid" ||
              !["/api/delivery/host", "/api/delivery/native"].includes(path)
            )
              throw new Error("unexpected_controller_url");
            if (typeof init.body !== "string") throw new Error("invalid_fixture_body");
            const value = JSON.parse(init.body);
            posts.push({
              path,
              operation: value.command?.operation ?? null,
              source: value.source?.kind ?? null,
              sequence: value.sequence ?? null,
            });
            try {
              const result = path.endsWith("/native")
                ? await f.native.ingest(value)
                : await manager.execute(value);
              if (value.command?.operation === "claim_step") {
                const claim = claimSchema.parse(result);
                claims[stage] = claim;
                if (stage > 0) {
                  const evidenceId = randomUUID();
                  await repository.recordEvidence(f.user.id, "fixture-ci", {
                    id: evidenceId,
                    stepId: steps[stage],
                    remoteId: randomUUID(),
                    kind: "check",
                    status: "passed",
                    verificationMode: "simulated",
                    environment: "canonical-host-native-pg",
                    sourceSha: f.context.revision,
                    criterionIds: ["C1"],
                    objectKey: `delivery/${f.user.id}/fixture/${evidenceId}.json`,
                    contentDigest: "b".repeat(64),
                    observedAt: new Date(Date.now() - 100),
                  });
                  evidence.set(steps[stage], evidenceId);
                }
              }
              return Response.json(result);
            } catch (error) {
              errors.push(error instanceof Error ? error.message : "controller_error");
              return Response.json({ error: "fixture_controller_rejected" }, { status: 409 });
            }
          },
        });
        supervisor.setManagerAdapter(adapter);
        const created = await supervisor.command({
          operation: "ensureProject",
          projectId: f.project.id,
          creationIntentId: randomUUID(),
        });
        rootThreadId = created.threadId;
        const store = new PrismaRegistrationStore(db),
          grantId = randomUUID(),
          now = Math.floor(Date.now() / 1000),
          grantDigest = hash(randomUUID());
        const generation = await store.reserve({ grantId, binding: f.host, expiresAt: now + 60 });
        await store.seal({ grantId, generation, grantDigest });
        expect(
          await store.consumeAndRegister({
            grantId,
            grantDigest,
            expiresAt: now + 60,
            now,
            registration: {
              binding: f.host,
              serverInstanceId: supervisor.state.serverInstanceId,
              protocolVersion: "0.165.0",
              threads: [{ projectId: f.project.id, repositoryId: "123", threadId: rootThreadId }],
              hostPublicKeyPem: f.keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
              generation,
              registeredAt: now,
              expiresAt: now + 60,
            },
          }),
        ).toBe(true);
        activeRegistration = {
          id: grantId,
          serverInstanceId: supervisor.state.serverInstanceId,
          expiresAt: (now + 60) * 1000,
          threads: [{ projectId: f.project.id, threadId: rootThreadId }],
        };
        await db.projectTaskIntent.update({
          where: { id: f.context.preparationIntentId },
          data: {
            status: {
              schemaVersion: 1,
              projectId: f.project.id,
              taskId: f.context.preparationIntentId,
              phase: "running",
              nativeThreadId: rootThreadId,
              terminalSessionName: null,
              reason: null,
            },
          },
        });
        const processBefore = processIdentity(runtime.processIdentity.pid);
        await supervisor.command({
          operation: "firstPrompt",
          projectId: f.project.id,
          requestId: randomUUID(),
          text: "HIVE_HOST_PROGRESSION_INITIAL: execute the fixed synthetic delivery fixture only.",
        });
        await until(
          async () => {
            if (errors.length) throw new Error(`fixture_rejected:${errors[0]}`);
            const result = await db.deliveryStep.findMany({
              where: { ownerId: f.user.id, taskId: f.taskId },
              select: { state: true },
            });
            return (
              result.length === 3 &&
              result.every((value) => ["reported", "succeeded"].includes(value.state))
            );
          },
          "three_step_progression_timeout",
          20000,
        );
        await until(async () => {
          const history = await runtime.call("thread/turns/list", {
            threadId: rootThreadId,
            limit: 20,
            sortDirection: "asc",
            itemsView: "full",
          });
          return (
            history.data.length === 3 &&
            history.data.every((turn: { status: string }) => turn.status === "completed")
          );
        }, "three_root_turns_not_terminal");
        const binding = await db.deliveryManagerBinding.findFirstOrThrow({
          where: { ownerId: f.user.id, projectId: f.project.id },
        });
        const attempts = await db.deliveryAttempt.findMany({
          where: { ownerId: f.user.id, managerBindingId: binding.id },
          orderBy: { startedAt: "asc" },
        });
        expect(attempts.map((value) => value.outcome)).toEqual([
          "reported",
          "succeeded",
          "succeeded",
        ]);
        expect(binding.cursorVersion).toBe(3);
        expect(binding.activeAttemptId).toBe(attempts[0].id);
        expect(binding.currentAttemptId).toBe(attempts[2].id);
        expect(attempts.every((value) => value.quiescedAt === null)).toBe(true);
        const processAfter = processIdentity(runtime.processIdentity.pid);
        expect(processAfter).toEqual(processBefore);
        expect(children).toHaveLength(2);
        expect(adapter.inspectNative()).toMatchObject({
          held: 1,
          attempts: 3,
          blocked: 0,
          pending: 0,
        });
        expect(
          await db.deliveryEvent.count({
            where: { ownerId: f.user.id, taskId: f.taskId, type: "native_root_boundary" },
          }),
        ).toBe(2);
        expect(
          await db.deliveryEvent.count({
            where: { ownerId: f.user.id, taskId: f.taskId, type: "native_boundary_consumed" },
          }),
        ).toBe(2);
        const history = await runtime.call("thread/turns/list", {
          threadId: rootThreadId,
          limit: 20,
          sortDirection: "asc",
          itemsView: "full",
        });
        const modelReceipts = history.data.flatMap(
          (turn: {
            items: {
              type: string;
              tool?: string;
              arguments?: { operation?: string };
              contentItems?: { type: string; text?: string }[];
            }[];
          }) =>
            turn.items
              .filter(
                (item) =>
                  item.type === "dynamicToolCall" &&
                  item.tool === "hive_delivery" &&
                  item.arguments?.operation === "claim_step",
              )
              .map((item) =>
                JSON.parse(
                  item.contentItems?.find((content) => content.type === "inputText")?.text ??
                    "null",
                ),
              ),
        );
        expect(modelReceipts).toHaveLength(3);
        expect(
          modelReceipts.every(
            (value: { canRun: boolean; needsRuntimeBinding: boolean }) =>
              value.canRun === false && value.needsRuntimeBinding === true,
          ),
        ).toBe(true);
        proof.checks = {
          sameRootAndNativeLifetime: true,
          exactlyThreeRootTurns: history.data.length === 3,
          twoDistinctDelegatedChildren: children.length === 2,
          cursorVersionThree: binding.cursorVersion === 3,
          physicalAnchorRetained: binding.activeAttemptId === attempts[0].id,
          currentAttemptThird: binding.currentAttemptId === attempts[2].id,
          signedBoundariesConsumedOnce: true,
          noQuiescenceClaim: true,
          noBrowserPromptRequired: true,
          reservationNeverPromotedToCanRun: true,
        };
        proof.native = {
          rootThreadId,
          serverInstanceId: supervisor.state.serverInstanceId,
          processBefore,
          processAfter,
          rootTurns: history.data.map((turn: { id: string; status: string }) => ({
            id: turn.id,
            status: turn.status,
          })),
          children,
        };
        proof.database = {
          ownerId: f.user.id,
          taskId: f.taskId,
          managerBindingId: binding.id,
          cursorVersion: binding.cursorVersion,
          nativeSequence: binding.nativeSequence,
          activeAttemptId: binding.activeAttemptId,
          currentAttemptId: binding.currentAttemptId,
          attempts: attempts.map((value) => ({
            id: value.id,
            outcome: value.outcome,
            quiescedAt: value.quiescedAt,
          })),
        };
        proof.reservationReceipts = claims.map((value) => ({
          attemptId: value.attemptId,
          cursorVersion: value.cursorVersion,
          nativeSequence: value.nativeSequence,
          canRun: value.canRun,
          needsRuntimeBinding: value.needsRuntimeBinding,
        }));
        proof.sourceStable = sourcesStable();
        expect(proof.sourceStable, "fixture_sources_changed_during_run").toBe(true);
        proof.passed = true;
      } catch (error) {
        proof.failure = error instanceof Error ? error.message.slice(0, 200) : "fixture_failed";
        throw error;
      } finally {
        proof.providerRequests = providerCount;
        proof.controllerOperations = posts;
        proof.safeErrorCodes = errors;
        proof.spool = adapter?.inspectNative() ?? null;
        try {
          await supervisor?.close();
          await adapter?.close();
          if (!supervisor) await runtime?.close();
          const pid = runtime?.processIdentity?.pid;
          if (pid && existsSync(`/proc/${pid}`)) shutdownFailed = true;
        } catch {
          shutdownFailed = true;
          proof.passed = false;
        }
        provider.closeAllConnections();
        await new Promise<void>((done) => provider.close(() => done()));
        if (shutdownFailed) {
          proof.passed = false;
          proof.cleanup = {
            status: "retained",
            scratchDirectory: home,
            reason: "shutdown_or_drain_failed",
          };
        } else {
          rmSync(home, { recursive: true, force: true });
          proof.cleanup = { status: "removed_after_native_exit", nativeProcessObservedGone: true };
        }
        proof.sourceStable = sourcesStable();
        if (!proof.sourceStable) {
          proof.passed = false;
          proof.failure = "fixture_sources_changed_during_run";
        }
        mkdirSync(resolve(output, ".."), { recursive: true });
        writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`);
        execFileSync("pnpm", ["exec", "biome", "format", "--write", output], { stdio: "ignore" });
      }
      expect(shutdownFailed, "fixture_shutdown_failed_scratch_retained").toBe(false);
      expect(proof.sourceStable, "fixture_sources_changed_during_run").toBe(true);
    }, 45000);
  },
);
