import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import {
  authorizeProjectReconcile,
  type ProjectReconcileEnvironment,
  projectReconcileFailure,
} from "../../../src/lib/projects/reconcile-transport";

type Context = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };
/** The app owns keys and the bounded DB lifetime; authentication precedes even
 * allocating that lifetime. The framework handler establishes its own context. */
export async function runProjectTaskReconciliation(
  request: Request,
  env: ProjectReconcileEnvironment & { DATABASE_URL?: string },
  context: Context,
  handle: (context: Context) => Promise<Response>,
) {
  const rejected = authorizeProjectReconcile(request, env);
  if (rejected) return projectReconcileFailure(rejected);
  const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
    queryTimeoutMillis: 10000,
    transactionTimeoutMillis: 10000,
  });
  const tasks = new Set<Promise<unknown>>();
  const tracked: Context = {
    passThroughOnException: () => context.passThroughOnException(),
    waitUntil(task) {
      const promise = Promise.resolve(task);
      tasks.add(promise);
      void promise.finally(() => tasks.delete(promise)).catch(() => {});
      context.waitUntil(promise);
    },
  };
  return database.run(async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await handle(tracked);
      if (
        response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
        "application/json"
      )
        throw new Error("Private response unavailable");
      reader = response.body?.getReader();
      if (!reader) throw new Error("Private response unavailable");
      const chunks: Uint8Array[] = [];
      let length = 0;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Private response unavailable")), 1000);
      });
      for (let count = 0; count < 64; count++) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) {
          // DB cleanup belongs to the completed operation, never to whether an
          // already-disconnected caller consumes this small fixed JSON response.
          return new Response(new Uint8Array(Buffer.concat(chunks)), {
            status: response.status,
            headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
          });
        }
        length += part.value.byteLength;
        if (length > 512) throw new Error("Private response unavailable");
        chunks.push(new Uint8Array(part.value));
      }
      throw new Error("Private response unavailable");
    } catch {
      return projectReconcileFailure(503);
    } finally {
      clearTimeout(timer);
      void reader?.cancel().catch(() => {});
      while (tasks.size) await Promise.allSettled([...tasks]);
      // No Promise.race around database work: an in-flight bounded query or
      // transaction must settle before disconnect and before returning success.
      await database.close();
    }
  });
}

/** Internal same-Worker invocation. No HTTP route, bearer or caller-supplied URL. */
export async function runExactProjectTaskWake(
  env: import("../../../src/lib/projects/task-wake-contracts").TaskWakeEnvironment & {
    DATABASE_URL?: string;
    HIVE_PROJECT_TASKS_ENABLED?: string;
  },
  receipt: import("../../../src/lib/projects/task-wake-contracts").TaskWakeReceipt,
): Promise<import("../../../src/lib/projects/task-wake-contracts").TaskWakeResult> {
  const { sameTaskWake, taskWakeEnrollment } = await import(
    "../../../src/lib/projects/task-wake-contracts"
  );
  const enrolled = taskWakeEnrollment(env);
  if (!enrolled || !sameTaskWake(enrolled, receipt) || env.HIVE_PROJECT_TASKS_ENABLED !== "true")
    return { phase: "held" };
  const deadline = Math.min(receipt.deadline, receipt.inFlightUntil);
  if (receipt.phase !== "active" || deadline <= Date.now()) return { phase: "held" };
  const signal = AbortSignal.timeout(deadline - Date.now());
  const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
    queryTimeoutMillis: 5000,
    transactionTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });
  const { withTaskWakeEnvironment } = await import("../../../src/lib/projects/task-wake.server");
  return withTaskWakeEnvironment(env, () =>
    database.run(async () => {
      try {
        signal.throwIfAborted();
        const { reconcileExactTaskWake } = await import("../../../src/lib/projects/task.server");
        return await reconcileExactTaskWake(receipt, signal);
      } finally {
        // close() seals the ALS context immediately; bound pool teardown as well.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            database.close(),
            new Promise<never>((_resolve, reject) => {
              cleanupTimer = setTimeout(
                () => reject(new Error("task_wake_cleanup_unavailable")),
                5000,
              );
            }),
          ]);
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
    }),
  );
}
