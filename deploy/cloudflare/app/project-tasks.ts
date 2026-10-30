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
