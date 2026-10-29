// Local-only read-only timeout fixture. Never used by the application entrypoint.
import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { validateRuntimeDatabase } from "./deployment-plan.mjs";

function timeoutKind(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 20) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && ["message", "originalMessage"].includes(key)) {
        if (/query read timeout/i.test(item)) return "query_read_timeout";
      } else if (item && typeof item === "object") pending.push(item);
    }
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && /query read timeout/i.test(message))
      return "query_read_timeout";
  }
  return "other_error";
}

export default {
  async fetch(request: Request, env: { PROOF_BEARER?: string; DATABASE_URL?: string }) {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/__local-query-bound" ||
      !env.PROOF_BEARER ||
      request.headers.get("Authorization") !== `Bearer ${env.PROOF_BEARER}`
    )
      return new Response(null, { status: 404 });
    validateRuntimeDatabase(env.DATABASE_URL);
    const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
      queryTimeoutMillis: 500,
      transactionTimeoutMillis: 1000,
    });
    const started = Date.now();
    let rejected = false,
      kind = "none",
      rejectedAtMilliseconds: number | null = null,
      closeCompleted = false;
    try {
      // Fixed, non-mutating SQL only. No user SQL, production URL or owner role.
      await database.run(() => getDb().$queryRaw`SELECT pg_sleep(2)`);
    } catch (error) {
      rejected = true;
      kind = timeoutKind(error);
      rejectedAtMilliseconds = Date.now() - started;
    } finally {
      try {
        await database.close();
        closeCompleted = true;
      } catch {}
    }
    return Response.json({
      rejected,
      kind,
      rejectedAtMilliseconds,
      closedAtMilliseconds: Date.now() - started,
      closeCompleted,
      queryTimeoutMillis: 500,
      transactionTimeoutMillis: 1000,
      connectionTimeoutMillis: 10000,
      sqlReadOnly: true,
      databaseDml: false,
    });
  },
};
