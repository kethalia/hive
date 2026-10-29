// Fixed local test harness only. Production auth/worker.ts never imports this.
import { randomUUID } from "node:crypto";
import { AuthServiceClient, encrypt, SECURE_SESSION_COOKIE_NAME, signCookie } from "@hive/auth";
import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { createSession } from "../../../services/auth/src/auth/domain";
import { listDeliveryTasks, readDeliveryTask } from "../../../src/lib/delivery/reads";
import { runRequestLifetime } from "../app/request-lifetime";
import authWorker from "./worker";

type Env = {
  DATABASE_URL: string;
  AUTH_SERVICE_SECRET: string;
  ENCRYPTION_KEY: string;
  PROOF_BEARER: string;
  RUN_UUID: string;
  COOKIE_SECRET: string;
  APP?: { fetch: typeof fetch };
};
type Context = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

function requireProof(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

function encrypted(token: string, key: string) {
  const result = encrypt(token, key);
  return {
    ciphertext: new Uint8Array(result.ciphertext),
    iv: new Uint8Array(result.iv),
    authTag: new Uint8Array(result.authTag),
  };
}

export default {
  async fetch(request: Request, env: Env, context: Context): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__local-auth-"))
      return env.APP ? env.APP.fetch(request) : new Response(null, { status: 404 });
    if (
      !["/__local-auth-proof", "/__local-auth-seed", "/__local-auth-cleanup"].includes(path) ||
      request.method !== "POST" ||
      request.headers.get("authorization") !== `Bearer ${env.PROOF_BEARER}`
    )
      return new Response(null, { status: 404 });
    const database = createCloudflareDatabaseRequest(env.DATABASE_URL);
    return runRequestLifetime(database, context, async () => {
      const db = getDb();
      const ownerId = env.RUN_UUID;
      const cleanup = async () => {
        await db.session.deleteMany({ where: { userId: ownerId } });
        await db.coderToken.deleteMany({ where: { userId: ownerId } });
        await db.deliveryTask.deleteMany({ where: { ownerId } });
        await db.deliveryProject.deleteMany({ where: { ownerId } });
        await db.user.deleteMany({ where: { id: ownerId } });
      };
      if (path === "/__local-auth-cleanup") {
        await cleanup();
        return Response.json({ cleaned: true });
      }
      if (path === "/__local-auth-seed") {
        try {
          await db.$transaction(
            async (tx) => {
              await tx.user.create({
                data: {
                  id: ownerId,
                  coderUserId: randomUUID(),
                  coderUrl: "https://coder.kethalia.com",
                  username: `local-proof-${ownerId}`,
                  email: `local-proof-${ownerId}@example.invalid`,
                },
              });
              await tx.deliveryProject.create({
                data: {
                  id: ownerId,
                  ownerId,
                  provider: "github",
                  providerRepositoryId: ownerId,
                  providerAccountId: ownerId,
                  fullName: "synthetic/local-binding-proof",
                },
              });
              await tx.deliveryTask.create({
                data: {
                  id: ownerId,
                  ownerId,
                  projectId: ownerId,
                  outcome: "Synthetic service binding task read",
                  sourceSha: "0".repeat(40),
                  branch: "synthetic-local-proof",
                },
              });
              await tx.session.create({
                data: {
                  sessionId: ownerId,
                  userId: ownerId,
                  expiresAt: new Date(Date.now() + 3600000),
                },
              });
            },
            { isolationLevel: "Serializable" },
          );
          return Response.json({
            taskId: ownerId,
            cookie: `${SECURE_SESSION_COOKIE_NAME}=${signCookie(ownerId, env.COOKIE_SECRET)}`,
          });
        } catch {
          await cleanup();
          return Response.json({ error: "Synthetic fixture setup failed" }, { status: 500 });
        }
      }
      const projectId = randomUUID();
      const taskId = randomUUID();
      let stage = "configuration";
      const checks: Record<string, boolean> = {};
      let knownError: Record<string, unknown> | undefined;
      try {
        stage = "runtime-role";
        const [role] = await db.$queryRaw<
          {
            current_user: string;
            rolsuper: boolean;
            rolcreatedb: boolean;
            rolcreaterole: boolean;
          }[]
        >`SELECT current_user::text AS current_user, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`;
        requireProof(
          role?.current_user === "hive_app_runtime" &&
            !role.rolsuper &&
            !role.rolcreatedb &&
            !role.rolcreaterole,
          stage,
        );
        checks.restrictedRuntimeRole = true;
        stage = "serializable-full-schema-commit";
        const token = encrypted(`synthetic-token-${ownerId}`, env.ENCRYPTION_KEY);
        await db.$transaction(
          async (tx) => {
            await tx.user.create({
              data: {
                id: ownerId,
                coderUserId: randomUUID(),
                coderUrl: "https://coder.kethalia.com",
                username: `local-proof-${ownerId}`,
                email: `local-proof-${ownerId}@example.invalid`,
              },
            });
            await tx.coderToken.create({
              data: { userId: ownerId, ...token, expiresAt: new Date(Date.now() + 7 * 86400000) },
            });
            await tx.deliveryProject.create({
              data: {
                id: projectId,
                ownerId,
                provider: "github",
                providerRepositoryId: ownerId,
                providerAccountId: ownerId,
                fullName: "synthetic/local-auth-proof",
              },
            });
            await tx.deliveryTask.create({
              data: {
                id: taskId,
                ownerId,
                projectId,
                outcome: "Synthetic local authentication task read",
                sourceSha: "0".repeat(40),
                branch: "synthetic-local-proof",
              },
            });
            const [locked] = await tx.$queryRaw<{ now: Date }[]>`
              SELECT clock_timestamp() AS now FROM delivery_tasks
              WHERE id = ${taskId}::uuid AND owner_id = ${ownerId}::uuid FOR UPDATE`;
            requireProof(locked.now instanceof Date, "server-clock-and-row-lock");
          },
          { isolationLevel: "Serializable" },
        );
        checks.serializableInteractiveFullSchemaCommit = true;
        checks.parameterizedRowLockAndServerClock = true;
        stage = "auth-worker-session";
        const sessionId = await createSession(ownerId);
        const client = new AuthServiceClient("https://auth.local", undefined, {
          serviceSecret: env.AUTH_SERVICE_SECRET,
          fetch: (input, init) => authWorker.fetch(new Request(input, init), env, context),
        });
        const session = await client.getSession(sessionId);
        requireProof(session?.userId === ownerId, stage);
        requireProof((await client.getCredentials(sessionId))?.status === "valid", "credentials");
        requireProof(
          (await client.getCoderToken(sessionId))?.token === `synthetic-token-${ownerId}`,
          "token-decryption",
        );
        checks.actualAuthWorkerSessionAndEncryptedCredentials = true;
        stage = "credential-version-cas";
        const rotated = encrypted(`synthetic-rotated-${ownerId}`, env.ENCRYPTION_KEY);
        const updated = await db.coderToken.updateMany({
          where: { userId: ownerId, version: 1 },
          data: { ...rotated, version: { increment: 1 } },
        });
        requireProof(updated.count === 1, stage);
        requireProof(
          (await client.getCoderToken(sessionId))?.token === `synthetic-rotated-${ownerId}`,
          stage,
        );
        requireProof(
          (
            await db.coderToken.updateMany({
              where: { userId: ownerId, version: 1 },
              data: { ...token, version: { increment: 1 } },
            })
          ).count === 0,
          "stale-credential-cas",
        );
        checks.credentialEncryptionVersionCAS = true;
        stage = "known-error-shape";
        try {
          await db.session.create({
            data: { sessionId, userId: ownerId, expiresAt: new Date(Date.now() + 86400000) },
          });
          throw new Error("Duplicate session unexpectedly accepted");
        } catch (failure) {
          const candidate = failure as {
            name?: string;
            code?: string;
            clientVersion?: string;
            meta?: {
              modelName?: string;
              target?: string | string[];
              driverAdapterError?: {
                name?: string;
                cause?: {
                  kind?: string;
                  constraint?: { fields?: string[]; index?: string };
                };
              };
            };
          };
          requireProof(candidate.code === "P2002", stage);
          knownError = {
            name: candidate.name,
            code: candidate.code,
            clientVersion: candidate.clientVersion,
            modelName: candidate.meta?.modelName,
            target: candidate.meta?.target,
            metaKeys: Object.keys(candidate.meta ?? {}),
            adapterErrorName: candidate.meta?.driverAdapterError?.name,
            adapterCauseKind: candidate.meta?.driverAdapterError?.cause?.kind,
            constraint: {
              fields: candidate.meta?.driverAdapterError?.cause?.constraint?.fields?.filter(
                (field) => field === "session_id",
              ),
              index:
                candidate.meta?.driverAdapterError?.cause?.constraint?.index ===
                "sessions_session_id_key"
                  ? "sessions_session_id_key"
                  : undefined,
            },
          };
        }
        checks.workerdKnownErrorObserved = true;
        stage = "task-reads";
        const page = await listDeliveryTasks(db, session.userId);
        requireProof(page?.tasks.length === 1 && page.tasks[0].id === taskId, stage);
        requireProof((await readDeliveryTask(db, session.userId, taskId))?.id === taskId, stage);
        requireProof(
          (await readDeliveryTask(db, randomUUID(), taskId)) === null,
          "cross-owner-read",
        );
        checks.actualTaskReadFunctionsAndOwnerIsolation = true;
        stage = "serializable-rollback";
        try {
          await db.$transaction(
            async (tx) => {
              await tx.deliveryTask.update({
                where: { id: taskId },
                data: { outcome: "rollback" },
              });
              throw new Error("deliberate-local-proof-rollback");
            },
            { isolationLevel: "Serializable" },
          );
        } catch (failure) {
          requireProof(
            failure instanceof Error && failure.message === "deliberate-local-proof-rollback",
            stage,
          );
        }
        requireProof(
          (await readDeliveryTask(db, ownerId, taskId))?.outcome ===
            "Synthetic local authentication task read",
          stage,
        );
        checks.serializableInteractiveRollback = true;
        stage = "session-expiry-and-revocation";
        const expiredId = randomUUID();
        await db.session.create({
          data: { sessionId: expiredId, userId: ownerId, expiresAt: new Date(Date.now() - 60000) },
        });
        requireProof((await client.getSession(expiredId)) === null, "expired-session");
        requireProof(
          (await db.session.count({ where: { sessionId: expiredId } })) === 0,
          "expired-session-cleanup",
        );
        await client.logout(sessionId);
        requireProof((await client.getSession(sessionId)) === null, "revoked-session");
        checks.expiredAndRevokedSessionsRejected = true;
        return Response.json({ ok: true, checks, knownError });
      } catch (failure) {
        const candidate = failure as { name?: string; code?: string };
        return Response.json(
          {
            ok: false,
            stage,
            checks,
            knownError,
            error: { name: candidate.name, code: candidate.code },
          },
          { status: 500 },
        );
      } finally {
        // Delete only this run's synthetic rows; never inspect or copy any other data.
        await cleanup();
      }
    });
  },
};
