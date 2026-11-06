// Local-only D10 pilot. This wrapper is never included in a deployment artifact.
import { randomUUID } from "node:crypto";
import { SECURE_SESSION_COOKIE_NAME, signCookie } from "@hive/auth";
import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { runRequestLifetime } from "../app/request-lifetime";

type Env = {
  DATABASE_URL: string;
  PILOT_BEARER: string;
  RUN_UUID: string;
  COOKIE_SECRET: string;
  APP: { fetch: typeof fetch };
};
type Context = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };
export default {
  async fetch(request: Request, env: Env, context: Context): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/__d10-pilot/")) {
      const url = new URL(request.url);
      url.protocol = "https:";
      url.host = "d10-pilot.invalid";
      const headers = new Headers(request.headers);
      headers.set("host", url.host);
      headers.set("x-forwarded-host", url.host);
      headers.set("x-forwarded-proto", "https");
      if (headers.has("origin")) headers.set("origin", url.origin);
      return env.APP.fetch(
        new Request(url, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
        }),
      );
    }
    if (
      request.method !== "POST" ||
      request.headers.get("authorization") !== `Bearer ${env.PILOT_BEARER}` ||
      new URL(env.DATABASE_URL).pathname !== "/hive_d10_pilot"
    )
      return new Response(null, { status: 404 });
    const database = createCloudflareDatabaseRequest(env.DATABASE_URL);
    return runRequestLifetime(database, context, async () => {
      const db = getDb(),
        id = env.RUN_UUID;
      if (pathname === "/__d10-pilot/seed") {
        await db.$transaction(
          async (tx) => {
            await tx.user.create({
              data: {
                id,
                coderUserId: randomUUID(),
                coderUrl: "https://coder.invalid",
                username: `d10-${id}`,
                email: `d10-${id}@example.invalid`,
              },
            });
            await tx.deliveryProject.create({
              data: {
                id,
                ownerId: id,
                provider: "github",
                providerRepositoryId: id,
                providerAccountId: id,
                fullName: "synthetic/d10-pilot",
              },
            });
            await tx.deliveryTask.create({
              data: {
                id,
                ownerId: id,
                projectId: id,
                outcome: "D10 mixed-version pilot",
                sourceSha: "0".repeat(40),
                branch: "d10-pilot",
              },
            });
            await tx.session.create({
              data: { sessionId: id, userId: id, expiresAt: new Date(Date.now() + 3600000) },
            });
          },
          { isolationLevel: "Serializable" },
        );
        return Response.json({
          taskId: id,
          cookie: `${SECURE_SESSION_COOKIE_NAME}=${signCookie(id, env.COOKIE_SECRET)}`,
        });
      }
      return new Response(null, { status: 404 });
    });
  },
};
