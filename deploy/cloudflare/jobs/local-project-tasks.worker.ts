// LOCAL PROOF ONLY: production private app lifetime + route, without a Next build.

import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { neonConfig } from "../../../packages/db/node_modules/@neondatabase/serverless/index.mjs";
import { projectReconcileRoute } from "../../../src/lib/projects/reconcile-route.server";
import {
  PROJECT_RECONCILE_DEADLINE,
  PROJECT_RECONCILE_PATH,
} from "../../../src/lib/projects/reconcile-transport";
import { runProjectTaskReconciliation } from "../app/project-tasks";
import { dispatchScheduled } from "./worker";

type Env = {
  [key: string]: unknown;
  DATABASE_URL?: string;
  WS_PORT?: string;
  ROLE: string;
  HIVE_PROJECT_TASKS_ENABLED: string;
  HIVE_PROJECT_TASK_RECONCILE_SECRET: string;
  APP_SERVICE?: { fetch: typeof fetch };
};
type Context = { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void };
export default {
  async fetch(request: Request, env: Env, context: Context) {
    if (env.ROLE === "jobs") {
      if (env.DATABASE_URL || "ENCRYPTION_KEY" in env || "HIVE_CODEX_ISSUER_PRIVATE_KEY" in env)
        throw new Error("Jobs must not receive app keys");
      if (
        request.headers.get("X-Local-Cancel") === "true" ||
        request.headers.get("X-Local-Deadline") === "true"
      ) {
        if (!env.APP_SERVICE) throw new Error("Missing local binding");
        const controller = new AbortController(),
          early = request.headers.get("X-Local-Cancel") === "true",
          timer = setTimeout(() => controller.abort(), early ? 100 : 60000);
        try {
          const response = await env.APP_SERVICE.fetch(
            `https://hive-app.internal${PROJECT_RECONCILE_PATH}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.HIVE_PROJECT_TASK_RECONCILE_SECRET}`,
                "Content-Type": "application/json",
                [PROJECT_RECONCILE_DEADLINE]: String(Date.now() + (early ? 45000 : 500)),
              },
              body: '{"schemaVersion":1}',
              signal: controller.signal,
            },
          );
          await response.body?.cancel();
          return Response.json({
            cancelled: controller.signal.aborted,
            appStatus: response.status,
          });
        } catch {
          return Response.json({ cancelled: controller.signal.aborted });
        } finally {
          clearTimeout(timer);
        }
      }
      return Response.json(await dispatchScheduled(env));
    }
    if (!env.DATABASE_URL || new URL(env.DATABASE_URL).hostname !== "127.0.0.1")
      throw new Error("Local fixture database required");
    neonConfig.wsProxy = () => `127.0.0.1:${env.WS_PORT}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineConnect = false;
    neonConfig.pipelineTLS = false;
    if (new URL(request.url).pathname === "/__pg-timeout") {
      const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
        queryTimeoutMillis: 1000,
        transactionTimeoutMillis: 1000,
        statementTimeoutMillis: 100,
      });
      return database.run(async () => {
        try {
          const db = getDb(),
            values = await db.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`;
          if (values[0].statement_timeout !== "100ms") throw new Error("Server timeout missing");
          try {
            await db.$queryRaw`SELECT pg_sleep(2)`;
          } catch (error) {
            const e = error as {
              code?: string;
              meta?: {
                code?: string;
                driverAdapterError?: {
                  cause?: { originalCode?: string; code?: string; kind?: string };
                };
              };
            };
            return Response.json({
              serverConfigured: true,
              sqlstate:
                e.meta?.code ??
                e.meta?.driverAdapterError?.cause?.originalCode ??
                e.meta?.driverAdapterError?.cause?.code ??
                null,
              prismaCode: e.code ?? null,
              metaKeys: Object.keys(e.meta ?? {}),
              adapterCauseKeys: Object.keys(e.meta?.driverAdapterError?.cause ?? {}),
            });
          }
          throw new Error("Query did not time out");
        } finally {
          await database.close();
        }
      });
    }
    return runProjectTaskReconciliation(request, env, context, () =>
      projectReconcileRoute(request),
    );
  },
};
