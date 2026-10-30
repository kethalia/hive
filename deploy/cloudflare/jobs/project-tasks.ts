import {
  PROJECT_RECONCILE_DEADLINE,
  PROJECT_RECONCILE_PATH,
  type ProjectReconcileEnvironment,
  projectReconcileSecret,
} from "../../../src/lib/projects/reconcile-transport";

export type ProjectTaskEnvironment = ProjectReconcileEnvironment & {
  APP_SERVICE?: { fetch: typeof fetch };
};
/** This wakeup has no selectors or decryption/issuer keys. The app owns claims,
 * Coder authorization and durable retry. Unknown replies are never successes. */
export async function dispatchProjectTaskReconciliation(env: ProjectTaskEnvironment) {
  if (env.HIVE_PROJECT_TASKS_ENABLED !== "true") return { enabled: false };
  const secret = projectReconcileSecret(env),
    service = env.APP_SERVICE;
  if (!secret || !service || typeof service.fetch !== "function")
    throw new Error("Project reconciliation binding unavailable");
  const controller = new AbortController(),
    signal = controller.signal,
    timer = setTimeout(() => controller.abort(), 60000);
  let response: Response | undefined;
  try {
    response = await service.fetch(`https://hive-app.internal${PROJECT_RECONCILE_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        [PROJECT_RECONCILE_DEADLINE]: String(Date.now() + 45000),
      },
      body: JSON.stringify({ schemaVersion: 1 }),
      redirect: "manual",
      signal,
    });
    signal.throwIfAborted();
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== `https://hive-app.internal${PROJECT_RECONCILE_PATH}`) ||
      response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
        "application/json"
    )
      throw new Error("Project reconciliation unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Project reconciliation unavailable");
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (let count = 0; count < 64; count++) {
        signal.throwIfAborted();
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (
            !result ||
            Object.keys(result).sort().join() !== "processed,retry,schemaVersion,stale" ||
            result.schemaVersion !== 1 ||
            ![result.processed, result.retry, result.stale].every(
              (n) => Number.isInteger(n) && n >= 0 && n <= 1,
            ) ||
            result.processed + result.retry + result.stale > 1
          )
            throw new Error("Project reconciliation unavailable");
          return {
            enabled: true,
            processed: result.processed,
            retry: result.retry,
            stale: result.stale,
          };
        }
        bytes += part.value.byteLength;
        if (bytes > 512) throw new Error("Project reconciliation unavailable");
        chunks.push(part.value);
      }
      throw new Error("Project reconciliation unavailable");
    } finally {
      signal.removeEventListener("abort", abort);
      void reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    void response?.body?.cancel().catch(() => {});
  }
}
