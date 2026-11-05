// Local-only F08 front worker. Never imported by the deployed app or auth Worker.
import { createHash, randomUUID } from "node:crypto";
import { encrypt, SECURE_SESSION_COOKIE_NAME, signCookie } from "@hive/auth";
import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { runRequestLifetime } from "../app/request-lifetime";

type Env = {
  DATABASE_URL: string;
  F08_BEARER: string;
  F08_RUN_ID: string;
  F08_VALID_SESSION: string;
  F08_EXPIRED_SESSION: string;
  F08_SYNTHETIC_TOKEN: string;
  F08_WRONG_KEY: string;
  COOKIE_SECRET: string;
  ENCRYPTION_KEY: string;
  AUTH_SERVICE_SECRET: string;
  APP: { fetch: typeof fetch };
  AUTH_SERVICE: { fetch: typeof fetch };
};
type Context = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };
export default {
  async fetch(request: Request, env: Env, context: Context): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__f08/")) {
      if (
        new URL(request.url).search ||
        !(
          (request.method === "GET" && path === "/api/delivery/tasks") ||
          (request.method === "POST" && path === "/api/auth/logout")
        )
      )
        return new Response(null, { status: 404 });
      const url = new URL(request.url);
      url.protocol = "https:";
      url.host = "f08-rehearsal.invalid";
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
    const u = new URL(env.DATABASE_URL);
    if (
      request.method !== "POST" ||
      request.headers.get("authorization") !== `Bearer ${env.F08_BEARER}` ||
      u.pathname !== "/hive_production_rehearsal_20261105" ||
      createHash("sha256").update(u.hostname.replace("-pooler.", ".")).digest("hex") !==
        "0c2e055f1031ffce660a74f2483fadcbf7a15033a61f4158dc5f3c3c8e8cd933" ||
      !/^hive_f08_[a-f0-9]{16}$/.test(u.username)
    )
      return new Response(null, { status: 404 });
    if (path === "/__f08/token" || path === "/__f08/reject-service-key") {
      const token =
        path === "/__f08/reject-service-key" ? "invalid-fixture-key" : env.AUTH_SERVICE_SECRET;
      const response = await env.AUTH_SERVICE.fetch(
        new Request(`https://auth.invalid/sessions/${env.F08_VALID_SESSION}/token`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      if (path === "/__f08/reject-service-key")
        return Response.json({ rejected: response.status === 401 });
      const body = (await response.json()) as { token?: string; code?: string };
      return Response.json({
        accepted: response.ok && body.token === env.F08_SYNTHETIC_TOKEN,
        wrongKeyRejected:
          !response.ok && ["KEY_MISMATCH", "DECRYPT_FAILED"].includes(body.code ?? ""),
      });
    }
    const database = createCloudflareDatabaseRequest(env.DATABASE_URL);
    return runRequestLifetime(database, context, async () => {
      const db = getDb(),
        id = env.F08_RUN_ID;
      if (path === "/__f08/seed" && env.F08_WRONG_KEY !== "true") {
        const encrypted = encrypt(env.F08_SYNTHETIC_TOKEN, env.ENCRYPTION_KEY);
        await db.$transaction(
          async (tx) => {
            await tx.user.create({
              data: {
                id,
                coderUserId: randomUUID(),
                coderUrl: "https://coder.invalid",
                username: `f08-${id}`,
                email: `f08-${id}@example.invalid`,
              },
            });
            await tx.coderToken.create({
              data: {
                userId: id,
                ciphertext: new Uint8Array(encrypted.ciphertext),
                iv: new Uint8Array(encrypted.iv),
                authTag: new Uint8Array(encrypted.authTag),
                expiresAt: new Date(Date.now() + 86400000),
              },
            });
            await tx.session.create({
              data: {
                sessionId: env.F08_VALID_SESSION,
                userId: id,
                expiresAt: new Date(Date.now() + 3600000),
              },
            });
            await tx.session.create({
              data: {
                sessionId: env.F08_EXPIRED_SESSION,
                userId: id,
                expiresAt: new Date(Date.now() - 3600000),
              },
            });
            await tx.deliveryProject.create({
              data: {
                id,
                ownerId: id,
                provider: "github",
                providerRepositoryId: id,
                providerAccountId: id,
                fullName: "synthetic/f08-rehearsal",
              },
            });
            await tx.deliveryTask.create({
              data: {
                id,
                ownerId: id,
                projectId: id,
                outcome: "F08 isolated compatibility",
                sourceSha: "0".repeat(40),
                branch: "f08-rehearsal",
              },
            });
          },
          { isolationLevel: "Serializable" },
        );
        const cookie = (session: string) =>
          `${SECURE_SESSION_COOKIE_NAME}=${signCookie(session, env.COOKIE_SECRET)}`;
        return Response.json({
          taskId: id,
          validCookie: cookie(env.F08_VALID_SESSION),
          expiredCookie: cookie(env.F08_EXPIRED_SESSION),
        });
      }
      if (path === "/__f08/cleanup" && env.F08_WRONG_KEY !== "true") {
        await db.$transaction(
          async (tx) => {
            await tx.deliveryTask.deleteMany({ where: { ownerId: id, id } });
            await tx.deliveryProject.deleteMany({ where: { ownerId: id, id } });
            await tx.session.deleteMany({
              where: {
                userId: id,
                sessionId: { in: [env.F08_VALID_SESSION, env.F08_EXPIRED_SESSION] },
              },
            });
            await tx.coderToken.deleteMany({ where: { userId: id } });
          },
          { isolationLevel: "Serializable" },
        );
        return Response.json({ cleaned: true });
      }
      return new Response(null, { status: 404 });
    });
  },
};
