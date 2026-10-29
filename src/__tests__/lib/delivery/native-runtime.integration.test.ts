import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PrismaClient } from "@hive/db";
import { afterAll, expect, it } from "vitest";
import {
  createDeliveryManagerAdapter,
  deliveryManagerToolSpec,
} from "../../../../templates/ai-dev-k8s/scripts/delivery-manager-adapter.mjs";
import { nativeFixture } from "./native-fixture";

type EnabledAdapter = {
  [K in keyof ReturnType<typeof createDeliveryManagerAdapter>]-?: NonNullable<
    ReturnType<typeof createDeliveryManagerAdapter>[K]
  >;
};

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
function response(res: ServerResponse, item: Record<string, unknown>, index: number) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    {
      type: "response.created",
      response: { id: `fixture_${index}`, status: "in_progress", output: [] },
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
        id: `fixture_${index}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ])
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}
it.skipIf(!url || process.env.HIVE_TEST_NATIVE_CODEX !== "1")(
  "actual native child facts cross the signed observer path into PostgreSQL without account inference",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "hive-native-durable-"));
    let managerThreadId = "",
      harness: Awaited<ReturnType<typeof nativeFixture>> | undefined,
      adapter: EnabledAdapter | undefined;
    let nativeRequests = 0,
      rootRequests = 0;
    const childCommands = new Set<string>(),
      errors: string[] = [],
      methods: string[] = [],
      childItems: unknown[] = [],
      children = new Set<string>();
    const provider = createServer((req, res) => {
      let text = "";
      req.on("data", (chunk) => (text += chunk));
      req.on("end", () => {
        const body = JSON.parse(text);
        nativeRequests++;
        const metadata = body.client_metadata ?? {},
          threadId = metadata.thread_id ?? body.prompt_cache_key;
        const detail = JSON.parse(metadata["x-codex-turn-metadata"] ?? "{}");
        const message = {
          id: `message_${nativeRequests}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "LOCAL_FIXTURE_DONE", annotations: [] }],
        };
        let item: Record<string, unknown> = message;
        if (threadId === managerThreadId) {
          rootRequests++;
          const command =
            rootRequests === 1
              ? { operation: "create_task", payload: harness!.definition }
              : rootRequests === 2
                ? {
                    operation: "claim_step",
                    payload: {
                      taskId: harness!.taskId,
                      stepId: harness!.stepId,
                      expectedVersion: 0,
                      requestedModel: "gpt-6.1-sol",
                      requestedEffort: "low",
                    },
                  }
                : null;
          if (command)
            item = {
              id: `root_call_${rootRequests}`,
              type: "function_call",
              name: "hive_delivery",
              call_id: `delivery_${rootRequests}`,
              arguments: JSON.stringify(command),
              status: "completed",
            };
          else if (rootRequests === 3)
            item = {
              id: "spawn_fixture",
              type: "function_call",
              namespace: "collaboration",
              name: "spawn_agent",
              call_id: "spawn_fixture",
              arguments: JSON.stringify({
                task_name: "fixture_child",
                message:
                  "READ_ONLY_CHILD_FIXTURE. Execute the supplied read-only local fixture command then finish. No network or file changes.",
                model: "gpt-6.1-sol",
                reasoning_effort: "low",
                fork_turns: "none",
              }),
              status: "completed",
            };
        } else if (detail.agent_name === "/root/fixture_child" && !childCommands.has(threadId)) {
          childCommands.add(threadId);
          item = {
            id: "exec_fixture",
            type: "custom_tool_call",
            namespace: "functions",
            name: "exec",
            call_id: "exec_fixture",
            input: `const result = await tools.exec_command({cmd: "printf HIVE_NATIVE_EXECUTION_OBSERVED", workdir: ${JSON.stringify(directory)}}); text(result);`,
            status: "completed",
          };
        }
        response(res, item, nativeRequests);
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
    mkdirSync(join(directory, ".codex"), { mode: 0o700 });
    const executable =
      process.env.HIVE_TEST_CODEX_EXECUTABLE ??
      "/home/coder/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
    writeFileSync(
      join(directory, ".codex/config.toml"),
      `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\napproval_policy = "never"\ndefault_permissions = "hive-fixture"\ncheck_for_update_on_startup = false\n[permissions.hive-fixture]\nfilesystem = { ":minimal" = "read", ${JSON.stringify(directory)} = "write", ${JSON.stringify(executable)} = "read" }\nnetwork = { enabled = false }\n[model_providers.fixture]\nname = "Local fixture only"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\napps = false\nplugins = false\nmemories = false\n`,
    );
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        USER: process.env.USER,
        HOME: directory,
        CODEX_HOME: join(directory, ".codex"),
        NODE_ENV: "test",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pending = new Map<
      number,
      {
        resolve: (value: any) => void;
        reject: (error: unknown) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let next = 1;
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const rpc = (method: string, params: unknown) =>
      new Promise<any>((resolve, reject) => {
        const id = next++,
          timer = setTimeout(() => reject(new Error("Native fixture request timeout")), 5000);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method) {
        methods.push(message.method);
        if (children.has(message.params?.threadId) && message.method === "item/completed")
          childItems.push(message.params.item);
        if (message.method === "item/tool/call") {
          if (!adapter) throw new Error("Adapter not initialized");
          void adapter
            .handleToolCall(message.params)
            .then((result) => send({ id: message.id, result }))
            .catch((error) => {
              errors.push(String(error));
              send({
                id: message.id,
                result: {
                  contentItems: [{ type: "inputText", text: "Fixture controller rejected" }],
                  success: false,
                },
              });
            });
          return;
        }
        if (
          adapter &&
          (message.params?.threadId === managerThreadId || children.has(message.params?.threadId))
        ) {
          try {
            adapter.observe({ method: message.method, params: message.params });
          } catch (error) {
            errors.push(String(error));
          }
        }
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        message.error
          ? waiter.reject(new Error("Native fixture request rejected"))
          : waiter.resolve(message.result);
      }
    });
    try {
      await rpc("initialize", {
        clientInfo: { name: "hive_native_durable_fixture", version: "1" },
        capabilities: { experimentalApi: true },
      });
      send({ method: "initialized" });
      const started = await rpc("thread/start", {
        cwd: directory,
        model: "gpt-6.1-sol",
        permissions: "hive-fixture",
        dynamicTools: [deliveryManagerToolSpec],
        experimentalRawEvents: true,
      });
      managerThreadId = started.thread.id;
      harness = await nativeFixture(db, managerThreadId);
      const f = harness;
      adapter = createDeliveryManagerAdapter({
        enabled: true,
        nativeEnabled: true,
        hiveOrigin: "https://hive.example.invalid",
        stateDirectory: join(directory, "delivery"),
        hostPrivateKeyPem: f.keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        currentRegistration: f.registration,
        currentProjectContext: (thread: string) => {
          expect(thread).toBe(managerThreadId);
          return f.context;
        },
        currentServerInstanceId: () => f.serverInstanceId,
        registerChild: (parent: string, nativeChild: string) => {
          expect(parent).toBe(managerThreadId);
          children.add(nativeChild);
        },
        readNativeHistory: async ({ childThreadId }: { childThreadId: string }) => {
          expect(children.has(childThreadId)).toBe(true);
          return rpc("thread/turns/list", {
            threadId: childThreadId,
            limit: 20,
            sortDirection: "asc",
            itemsView: "full",
          });
        },
        fetchImpl: async (target: string, init: RequestInit) => {
          try {
            const payload = JSON.parse(String(init.body));
            const result = target.endsWith("/api/delivery/native")
              ? await f.native.ingest(payload)
              : await f.manager.execute(payload);
            return Response.json(result);
          } catch (error) {
            errors.push(error instanceof Error ? error.message : "Fixture rejection");
            return Response.json({ error: "fixture_rejected" }, { status: 409 });
          }
        },
      }) as EnabledAdapter;
      await rpc("turn/start", {
        threadId: managerThreadId,
        input: [
          {
            type: "text",
            text: "ROOT_MANAGER_FIXTURE: reserve one delivery step and delegate a read-only child.",
            text_elements: [],
          },
        ],
      });
      let observed = false;
      for (let count = 0; count < 160; count++) {
        await adapter.flushNative();
        if (
          await db.deliveryEvent.count({
            where: { ownerId: f.user.id, type: "native_attempt_observed" },
          })
        ) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(errors).toEqual([]);
      expect(observed).toBe(true);
      expect(rootRequests).toBeGreaterThanOrEqual(3);
      expect(childCommands.size).toBe(1);
      const rows = await db.deliveryEvent.findMany({
        where: { ownerId: f.user.id, attemptId: { not: null } },
        orderBy: { aggregateVersion: "asc" },
      });
      expect(rows.some((row) => row.type === "native_runtime_started")).toBe(true);
      expect(
        rows.some((row) => row.type === "native_command_observed"),
        JSON.stringify({ childItems, methods }),
      ).toBe(true);
      const command = rows.find((row) => row.type === "native_command_observed")?.payload as
        | { source?: { exitCode?: unknown; commandDigest?: unknown; outputDigest?: unknown } }
        | undefined;
      expect(command?.source?.exitCode).toBe(0);
      expect(command?.source?.commandDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(command?.source?.outputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(rows.map((row) => row.payload))).not.toContain(
        "printf HIVE_NATIVE_EXECUTION_OBSERVED",
      );
      expect(await db.deliveryEvidence.count({ where: { ownerId: f.user.id } })).toBe(0);
      const attempt = await db.deliveryAttempt.findFirstOrThrow({ where: { ownerId: f.user.id } });
      expect(attempt.effectiveModel).toBe("gpt-6.1-sol");
      expect(attempt.effectiveEffort).toBe("low");
      expect(attempt.quiescedAt).toBeNull();
      expect(adapter.inspectNative()).toMatchObject({ pending: 0, held: 1, blocked: 0 });
    } finally {
      await adapter?.close();
      for (const value of pending.values()) clearTimeout(value.timer);
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        timer.unref();
      });
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20000,
);
