import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { DeliverySourcePublicationService } from "@/lib/delivery/source-publication.server";
import { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";
import {
  collectCompletionProviderFacts,
  completionServices,
} from "./acceptance-completion-fixture";
import { acceptanceFixtureProducer } from "./acceptance-fixture";
import { repairApplicationFixture } from "./acceptance-repair-fixture";

const url = process.env.HIVE_ACCEPTANCE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !new URL(url).pathname.startsWith("/hive_acceptance_test"))
)
  throw Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
const hash = (v: Buffer) => createHash("sha256").update(v).digest("hex");
describe.skipIf(!url || process.env.HIVE_TEST_NATIVE_CODEX !== "1")(
  "actual native repair and independent re-review with signed PostgreSQL services",
  () => {
    it("failed exact B becomes same-step repair on B, publishes C and obtains fresh independent review without weakening criteria", async () => {
      const modulePath = (name: string) =>
        new URL(`../../../../templates/ai-dev-k8s/scripts/${name}.mjs`, import.meta.url).href;
      const [
        { launchNative },
        { createNativeAcceptanceEvaluator },
        { createAcceptanceClient },
        { createAcceptancePump },
      ] = await Promise.all([
        import(modulePath("codex-project-supervisor")),
        import(modulePath("codex-acceptance-native")),
        import(modulePath("delivery-acceptance-client")),
        import(modulePath("codex-acceptance-pump")),
      ]);
      const producer = { ...acceptanceFixtureProducer, model: "gpt-6.1-sol" };
      let mode = "initial",
        output: unknown = { fixture: true },
        managerCalls = 0,
        requests = 0;
      let claimArguments: unknown;
      const reviewerTools: unknown[] = [];
      const server = createServer((req, res) => {
        if (req.method !== "POST") {
          res.writeHead(404);
          res.end();
          return;
        }
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          requests++;
          const input = JSON.parse(raw);
          if (mode.startsWith("review")) reviewerTools.push(input.tools ?? []);
          const item =
            mode === "repair" && managerCalls++ === 0
              ? {
                  id: "claim-item",
                  type: "function_call",
                  call_id: "repair-claim",
                  name: "hive_delivery",
                  arguments: JSON.stringify(claimArguments),
                }
              : {
                  id: `message-${requests}`,
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text:
                        mode === "repair"
                          ? "export const behavior = true;\n"
                          : JSON.stringify(output),
                      annotations: [],
                    },
                  ],
                };
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for (const event of [
            {
              type: "response.created",
              response: { id: `r${requests}`, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress" },
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: `r${requests}`,
                status: "completed",
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ])
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          res.end();
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("fixture bind");
      const home = mkdtempSync(join(process.cwd(), ".ar-")),
        stateDirectory = join(home, ".local/state/hive/repair"),
        cwd = join(home, "projects/.hive-managed/evaluator"),
        auth = join(home, ".local/share/hive/codex-native/codex");
      for (const p of [stateDirectory, cwd, auth]) mkdirSync(p, { recursive: true, mode: 0o700 });
      writeFileSync(join(auth, "auth.json"), "{}\n", { mode: 0o600 });
      const lock = openSync(join(stateDirectory, "fixture.lock"), "wx", 0o600),
        executable = realpathSync(
          process.env.HIVE_TEST_CODEX_EXECUTABLE ??
            "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
        );
      let native: any,
        evaluator: any,
        pump: any,
        passed = false;
      try {
        native = await launchNative({
          config: {
            codexExecutable: executable,
            codexSha256: hash(readFileSync(executable)),
            executionMode: "isolated",
            acceptance: producer,
          },
          home,
          stateDirectory,
          lock,
          fixtureProvider: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
        });
        const messages: any[] = [];
        native.observeInstalled((v: unknown) => messages.push(v));
        const thread = await native.call("thread/start", {
          model: producer.model,
          cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          dynamicTools: [
            {
              name: "hive_delivery",
              description: "Local signed-service fixture",
              inputSchema: {
                type: "object",
                properties: { operation: { type: "string" }, payload: { type: "object" } },
                required: ["operation", "payload"],
              },
            },
          ],
        });
        const terminal = async (turnId: string) => {
          const deadline = Date.now() + 10000;
          while (
            !messages.some(
              (v) =>
                v.method === "turn/completed" &&
                v.params.threadId === thread.thread.id &&
                v.params.turn.id === turnId,
            )
          ) {
            if (Date.now() > deadline) throw Error("fixture terminal deadline");
            await new Promise((r) => setTimeout(r, 5));
          }
        };
        const initial = await native.call("turn/start", {
          threadId: thread.thread.id,
          input: [
            {
              type: "text",
              text: "Canned fixture initial manager context; no execution.",
              text_elements: [],
            },
          ],
        });
        await terminal(initial.turn.id);
        // Initial provider publication/enrollment and child facts are explicit local
        // doubles. Repair manager turn and both independent review turns are native.
        const f = await acceptanceCandidateFixture(db, "export const behavior = false;\n", {
          producer,
          native: { managerThreadId: thread.thread.id, parentTurnId: initial.turn.id },
        });
        for (const flag of [
          "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
          "HIVE_DELIVERY_EXECUTION_ENABLED",
          "HIVE_DELIVERY_MANAGER_ENABLED",
          "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
        ])
          vi.stubEnv(flag, "true");
        vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_PRODUCER", JSON.stringify(producer));
        evaluator = createNativeAcceptanceEvaluator({
          runtime: native,
          producer,
          workingDirectory: cwd,
          state: {},
          save() {},
          assertAuthority() {},
          serverInstanceId: f.serverInstanceId,
        });
        native.setAcceptanceInterruptAuthority((scope: unknown) =>
          evaluator.assertInterrupt(scope),
        );
        let reviewOutcome: "fail" | "pass" = "fail",
          reviewSha = f.publication.headSha,
          reviewCandidate = f.candidate;
        const metadata = (await f.reviewer.dispatch(f.envelope({ action: "read_acceptance_plan" })))
          .producer;
        const acceptanceService = completionServices(db, f).service;
        const client = createAcceptanceClient({
          hiveOrigin: "https://acceptance.invalid",
          hostPrivateKeyPem: f.keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          currentContext: () => ({
            ownerId: f.user.id,
            managerThreadId: f.managerThreadId,
            registration: f.registration(),
            checkoutBinding: f.context,
          }),
          authorizeMetadata: async () => metadata,
          fetchImpl: async (_url: string, options: RequestInit) => {
            const request = JSON.parse(String(options.body)),
              response = await acceptanceService.dispatch(request);
            if (request.action === "claim_acceptance") {
              const job = response.result as { phase: string; inputDigest: string };
              if (job.phase === "leased")
                output = {
                  schemaVersion: 1,
                  kind: "review",
                  intentDigest: f.plan.intentDigest,
                  planDigest: acceptanceDigest(f.plan),
                  sourceSha: reviewSha,
                  inputDigest: job.inputDigest,
                  outcome: reviewOutcome,
                  requirements: [
                    {
                      id: "acceptance:behavior",
                      meaningDigest: requireIntentDigest(f.plan.requirements[0].meaning),
                      outcome: reviewOutcome,
                      rationale:
                        reviewOutcome === "fail"
                          ? "The exact candidate leaves behavior false."
                          : "The repaired candidate makes the requested behavior true.",
                      citations: [
                        {
                          entryId: "source:0",
                          artifactDigest: reviewCandidate.manifest.files[0].contentDigest,
                          start: 0,
                          end: 10,
                        },
                      ],
                    },
                  ],
                  unresolved: [],
                  rationale: "Canned independent evaluator; no account inference",
                };
            }
            return Response.json(response);
          },
        });
        pump = createAcceptancePump({
          client,
          evaluator,
          state: {},
          save() {},
          assertAuthority() {},
        });
        const firstPrepared = await client.request("prepare_review", { candidate: f.candidate });
        mode = "review-fail";
        await pump.tick();
        expect(
          (await client.request("read_acceptance", { jobId: firstPrepared.jobId })).result.outcome,
        ).toBe("fail");
        const reserved = await client.request("repair_prepare", {});
        expect(reserved.phase).toBe("reserved");
        const app = await repairApplicationFixture(db, f),
          appInput = app.reservation();
        await app.store.reserve(f.guardian.scope, appInput);
        await app.store.commit(f.guardian.scope, appInput.applicationId, app.receipt(appInput));
        const ready = await client.request("repair_ready", {
          repairId: reserved.reservation.repairId,
        });
        expect(ready.phase).toBe("ready");
        let next: any, boundary: any;
        native.setManagerAdapter({
          handleToolCall: async (params: any) => {
            expect(params.threadId).toBe(f.managerThreadId);
            expect(params.arguments).toEqual(claimArguments);
            boundary = f.sourceEnvelope(
              f.claim,
              {
                kind: "root_boundary",
                parentTurnId: f.parentTurnId,
                nextParentTurnId: params.turnId,
                cursorVersion: 1,
                observedAt: new Date(Date.now() - 1).toISOString(),
              },
              3,
              { sourceContext: app.accepted.sourceContext },
            );
            await f.native.ingest(boundary);
            next = await f.manager.execute(
              f.managerEnvelope(params.arguments, {
                nativeTurnId: params.turnId,
                nativeCallId: params.callId,
                sourceContext: app.accepted.sourceContext,
                continuation: {
                  boundaryEventId: boundary.eventId,
                  priorAttemptId: f.claim.attemptId,
                  cursorVersion: 1,
                  parentTurnId: f.parentTurnId,
                  nextParentTurnId: params.turnId,
                  sequence: 3,
                },
              }),
            );
            return {
              success: true,
              contentItems: [{ type: "inputText", text: JSON.stringify(next) }],
            };
          },
        });
        mode = "repair";
        claimArguments = {
          operation: "claim_step",
          payload: {
            taskId: f.taskId,
            stepId: f.stepId,
            expectedVersion: ready.expectedVersion,
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
          },
        };
        const repairTurn = await native.call("turn/start", {
          threadId: f.managerThreadId,
          input: [
            {
              type: "text",
              text: `Same-step repair only; first claim the unchanged criterion. Scoped immutable feedback data: ${JSON.stringify(reserved.reservation.feedback)}`,
              text_elements: [],
            },
          ],
        });
        await terminal(repairTurn.turn.id);
        expect(next.inputSourceSha).toBe(f.publication.headSha);
        expect(next.attemptId).not.toBe(f.claim.attemptId);
        const message = messages.find(
          (v) =>
            v.method === "item/completed" &&
            v.params.turnId === repairTurn.turn.id &&
            v.params.item.type === "agentMessage",
        );
        const text = message.params.item.text;
        expect(text).toBe("export const behavior = true;\n");
        const child = {
          parentTurnId: repairTurn.turn.id,
          spawnCallId: "repair-fixture-child",
          childThreadId: randomUUID(),
          childTurnId: randomUUID(),
          observedAt: new Date(Date.now() - 1).toISOString(),
        };
        await f.native.ingest(
          f.sourceEnvelope(
            next,
            {
              ...child,
              kind: "started",
              requestedModel: producer.model,
              requestedEffort: "low",
              effectiveModel: producer.model,
              effectiveEffort: "low",
            },
            4,
            { sourceContext: app.accepted.sourceContext },
          ),
        );
        await f.native.ingest(
          f.sourceEnvelope(next, { ...child, kind: "turn_completed", status: "completed" }, 5, {
            sourceContext: app.accepted.sourceContext,
          }),
        );
        const candidate = {
          manifest: {
            files: [
              {
                path: "src/behavior.ts",
                contentDigest: requireIntentDigest(text),
                size: Buffer.byteLength(text),
                mode: "100644",
                blobSha: createHash("sha1")
                  .update(`blob ${Buffer.byteLength(text)}\0`)
                  .update(text)
                  .digest("hex"),
              },
            ],
            deletions: [],
          },
          contents: [{ path: "src/behavior.ts", text }],
        };
        const operationId = randomUUID(),
          publication = {
            ...f.publication,
            operationId,
            branch: `codex/delivery/${f.taskId}/${operationId}`,
            attemptId: next.attemptId,
            sourceContext: app.accepted.sourceContext,
            expectedSourceVersion: 1,
            expectedRevisionId: app.accepted.sourceContext.revisionId,
            expectedCursorVersion: 2,
            expectedNativeSequence: 5,
            leaseGeneration: next.leaseGeneration,
            parentSha: f.publication.headSha,
            headSha: "c".repeat(40),
            treeSha: "d".repeat(40),
            manifestDigest: acceptanceDigest(candidate.manifest),
            issuedAt: Date.now() - 1,
            expiresAt: Date.now() + 30000,
          };
        const publisher = new DeliverySourcePublicationService(db, {
          reauthorize: f.dependencies.reauthorize,
          authority: {
            verify: async () => ({ publication, proofDigest: acceptanceDigest(publication) }),
            authorizeTransaction: async () => {},
          },
        });
        await publisher.accept({ explicitTrustedFixture: true });
        reviewOutcome = "pass";
        reviewSha = publication.headSha;
        reviewCandidate = candidate;
        mode = "review-pass";
        const secondPrepared = await client.request("prepare_review", { candidate });
        await pump.tick();
        const accepted = await client.request("read_acceptance", { jobId: secondPrepared.jobId });
        expect(accepted.result.outcome).toBe("pass");
        expect(secondPrepared.jobId).not.toBe(firstPrepared.jobId);
        expect(
          (await db.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } })).criterionIds,
        ).toEqual(["acceptance:behavior"]);
        const jobs = await db.deliveryAcceptanceJob.findMany({
          where: { ownerId: f.user.id, kind: "review" },
          orderBy: { createdAt: "asc" },
        });
        expect(jobs).toHaveLength(2);
        expect(jobs.every((j) => j.evaluatorThreadId !== f.managerThreadId)).toBe(true);
        expect(new Set(jobs.map((j) => j.evaluatorThreadId)).size).toBe(2);
        expect(reviewerTools).toEqual([[], []]);
        expect(
          (
            await db.deliveryManagerBinding.findUniqueOrThrow({
              where: { id: f.claim.managerBindingId },
            })
          ).activeAttemptId,
        ).toBe(f.claim.attemptId);
        expect(
          (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: f.claim.attemptId } }))
            .quiescedAt,
        ).toBeNull();
        // Missing independent repository gates still block completion; semantic pass
        // is not CI, activation or cleanup authority.
        expect((await client.request("repair_prepare", {})).phase).toBe("waiting");
        await collectCompletionProviderFacts(db, f, operationId);
        // Actual pinned native root history supplies terminal status. Child/source
        // observer facts remain the explicit doubles already disclosed above.
        const turns = await native.call("thread/turns/list", {
          threadId: f.managerThreadId,
          cursor: null,
          limit: 20,
          sortDirection: "asc",
        });
        expect(turns.nextCursor).toBeNull();
        expect(turns.data).toHaveLength(2);
        expect(turns.data.every((t: any) => t.status === "completed")).toBe(true);
        const source = await db.deliverySourceRevision.findFirstOrThrow({ where: { operationId } });
        const terminalFact = {
          schemaVersion: 1,
          managerBindingId: f.claim.managerBindingId,
          taskId: f.taskId,
          stepId: f.stepId,
          attemptId: next.attemptId,
          managerThreadId: f.managerThreadId,
          parentTurnId: repairTurn.turn.id,
          cursorVersion: 2,
          nativeSequence: 5,
          sourceContext: {
            revisionId: source.id,
            version: source.version,
            headSha: source.headSha,
          },
          observedAt: new Date().toISOString(),
          historyDigest: acceptanceDigest(turns),
          loadedInventoryDigest: "2".repeat(64),
          sourceJournalDigest: "3".repeat(64),
          rootCompleted: true,
          pendingHandlers: 0,
          pendingObservers: 0,
          unknownInputs: 0,
          cohort: [f.source, child].map((c) => ({
            parentTurnId: c.parentTurnId,
            spawnCallId: c.spawnCallId,
            childThreadId: c.childThreadId,
            childTurnId: c.childTurnId,
            effectiveModel: "gpt-6.1-sol",
            effectiveEffort: "low",
          })),
        };
        const completed = await client.request("complete_verified", { terminal: terminalFact });
        expect(completed.phase).toBe("completed");
        expect((await db.deliveryStep.findUniqueOrThrow({ where: { id: f.stepId } })).state).toBe(
          "succeeded",
        );
        expect(
          (
            await db.deliveryStepReport.findUniqueOrThrow({
              where: { id: completed.receipt.reportId },
            })
          ).difficulty,
        ).toBe("unknown");
        expect(
          (await db.deliveryAttempt.findUniqueOrThrow({ where: { id: next.attemptId } }))
            .quiescedAt,
        ).toBeNull();
        const evidence = {
          schemaVersion: 1,
          actualNativeVersion: "0.165.0",
          model: producer.model,
          effort: "low",
          managerThreadId: f.managerThreadId,
          initialTurnId: initial.turn.id,
          repairTurnId: repairTurn.turn.id,
          evaluatorThreadIds: jobs.map((j) => j.evaluatorThreadId),
          reviewOutcomes: ["fail", "pass"],
          candidateHeads: [f.publication.headSha, publication.headSha],
          sameStepId: f.stepId,
          attemptIds: [f.claim.attemptId, next.attemptId],
          criteriaUnchanged: true,
          physicalWriterHeld: true,
          requests,
          accountInference: false,
          providerPublication: "explicit-local-double",
          nativeChildFacts: "explicit-local-double",
          inputBarrierReceipt: "explicit-local-double",
          productionCompletion: false,
          controllerCompletion:
            "succeeded through real full repository/semantic policy with signed provider snapshot and observer doubles",
          completionEventId: completed.receipt.eventId,
        };
        if (process.env.HIVE_REPAIR_NATIVE_EVIDENCE_PATH)
          writeFileSync(
            process.env.HIVE_REPAIR_NATIVE_EVIDENCE_PATH,
            `${JSON.stringify(evidence, null, 2)}\n`,
          );
        passed = true;
      } finally {
        await pump?.close();
        evaluator?.close();
        await native?.close();
        closeSync(lock);
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        if (passed) rmSync(home, { recursive: true, force: true });
        else process.stderr.write(`Repair native fixture retained: ${home}\n`);
      }
    }, 45000);
  },
);
