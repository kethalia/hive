import { createHash } from "node:crypto";
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
import { afterAll, describe, expect, it } from "vitest";
import { requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { acceptanceFixtureProducer } from "./acceptance-fixture";
import { acceptanceGuardianFixture } from "./acceptance-guardian-fixture";

const url = process.env.HIVE_ACCEPTANCE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !(
      new URL(url).pathname.startsWith("/hive_acceptance_test") ||
      new URL(url).pathname === "/hive_delivery_test"
    ))
)
  throw Error("Local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test",
});
afterAll(() => db.$disconnect());
const hash = (v: Buffer) => createHash("sha256").update(v).digest("hex");
describe.skipIf(!url || process.env.HIVE_TEST_NATIVE_CODEX !== "1")(
  "actual pinned native to signed acceptance service",
  () => {
    it("automatically plans once, persists actual model provenance, and replays result ACK without inference", async () => {
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
      const f = await acceptanceGuardianFixture(db, undefined, producer);
      const plan = {
        schemaVersion: 1,
        kind: "plan",
        intentDigest: requireIntentDigest(f.originalIntent),
        outcome: "ready",
        requirements: [
          {
            id: "acceptance:behavior",
            meaning: "Preserve fixture behavior",
            phase: "implementation_preview",
            intentRanges: [{ start: 0, end: Buffer.byteLength(f.originalIntent) }],
            verification: "Inspect exact candidate source",
          },
        ],
        unresolved: [],
        rationale: "Canned local Responses; no account inference",
      };
      let requests = 0;
      const tools: unknown[] = [];
      const server = createServer((req, res) => {
        if (req.method !== "POST") {
          res.writeHead(404);
          res.end("{}");
          return;
        }
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          const input = JSON.parse(raw);
          requests++;
          tools.push(input.tools ?? []);
          const item = {
            id: "acceptance-message",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(plan), annotations: [] }],
          };
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for (const event of [
            { type: "response.created", response: { id: "r", status: "in_progress", output: [] } },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress" },
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: "r",
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
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("fixture bind");
      const home = mkdtempSync(join(process.cwd(), ".ai-")),
        stateDirectory = join(home, ".local/state/hive/acceptance"),
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
        passed = false,
        lost = false;
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
        const state = {};
        evaluator = createNativeAcceptanceEvaluator({
          runtime: native,
          producer,
          workingDirectory: cwd,
          state,
          save() {},
          assertAuthority() {},
          serverInstanceId: f.serverInstanceId,
        });
        native.setAcceptanceInterruptAuthority((scope: unknown) =>
          evaluator.assertInterrupt(scope),
        );
        const metadata = (await f.service.dispatch(f.envelope({ action: "read_acceptance_plan" })))
          .producer;
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
            const value = JSON.parse(String(options.body)),
              response = await f.service.dispatch(value);
            if (value.action === "finish_acceptance" && !lost) {
              lost = true;
              throw Error("lost_ack_after_database_commit");
            }
            return Response.json(response);
          },
        });
        const journal = {};
        const make = () =>
          createAcceptancePump({
            client,
            evaluator,
            state: journal,
            save() {},
            assertAuthority() {},
          });
        pump = make();
        await expect(pump.tick()).rejects.toThrow("lost_ack_after_database_commit");
        expect(requests).toBe(1);
        pump = make();
        await expect(pump.tick()).resolves.toMatchObject({ phase: "completed" });
        expect(requests).toBe(1);
        expect(tools).toEqual([[]]);
        const persisted = await db.deliveryAcceptanceJob.findFirstOrThrow({
          where: { ownerId: f.user.id, kind: "plan" },
        });
        expect(persisted.phase).toBe("completed");
        expect(persisted.receipt).toMatchObject({
          requestedModel: "gpt-6.1-sol",
          effectiveModel: "gpt-6.1-sol",
          requestedEffort: "low",
          effectiveEffort: "low",
          terminal: true,
          controllerCreated: true,
          unexpectedTools: 0,
        });
        expect(persisted.evaluatorThreadId).not.toBe(f.managerThreadId);
        expect(evaluator.active()).toBe(false);
        passed = true;
      } finally {
        pump?.close();
        evaluator?.close();
        await native?.close();
        closeSync(lock);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (passed) rmSync(home, { recursive: true, force: true });
        else process.stderr.write(`Acceptance native fixture retained: ${home}\n`);
      }
    }, 30000);
  },
);
