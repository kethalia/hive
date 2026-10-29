type Context = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };
type DatabaseRequest = { run<T>(operation: () => T): T; close(): Promise<void> };

/** Keep one request's pool alive through streamed rendering and Next after work. */
export async function runRequestLifetime(
  database: DatabaseRequest,
  context: Context,
  handle: (context: Context) => Promise<Response>,
): Promise<Response> {
  const tasks = new Set<Promise<unknown>>();
  const trackedContext: Context = {
    passThroughOnException: () => context.passThroughOnException(),
    waitUntil(task) {
      const tracked = Promise.resolve(task);
      tasks.add(tracked);
      void tracked.finally(() => tasks.delete(tracked)).catch(() => {});
      context.waitUntil(tracked);
    },
  };
  return database.run(async () => {
    try {
      const response = await handle(trackedContext);
      if (response.status === 101)
        throw new Error("WebSocket responses require a dedicated lifetime adapter.");
      let streamDone: Promise<unknown> = Promise.resolve();
      let result = response;
      if (response.body) {
        const stream = new TransformStream();
        streamDone = response.body.pipeTo(stream.writable);
        result = new Response(stream.readable, response);
      }
      context.waitUntil(
        (async () => {
          await streamDone.catch(() => {});
          while (tasks.size) await Promise.allSettled([...tasks]);
          await database.close();
        })(),
      );
      return result;
    } catch (error) {
      while (tasks.size) await Promise.allSettled([...tasks]);
      await database.close();
      throw error;
    }
  });
}
