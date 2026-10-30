// LOCAL TEST ONLY. Full generated workerd Prisma client over a fixed loopback WS bridge.
import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
// Prisma adapter-neon's ESM export loads the ESM driver. Configure that exact
// module, not its separate CJS main (which has independent global settings).
import { neonConfig } from "../../../packages/db/node_modules/@neondatabase/serverless/index.mjs";
import { publicationActorAuthorizer } from "../../../src/lib/templates/publication-actor";
import {
  type TemplateAssets,
  templateAssetsLoader,
  templatePublicationArtifact,
} from "../../../src/lib/templates/publication-artifact";
import { CoderTemplatePublicationProvider } from "../../../src/lib/templates/publication-provider";
import { templatePublicationRoutes } from "../../../src/lib/templates/publication-routes";
import { TemplatePublicationService } from "../../../src/lib/templates/publication-service";
import { runRequestLifetime } from "../app/request-lifetime";
import { publicationAuthClient } from "./template-publications";
import jobsWorker, { dispatchScheduled } from "./worker";

type Env = {
  DATABASE_URL: string;
  WS_PORT: string;
  PROOF_BEARER: string;
  AUTH_SERVICE_SECRET: string;
  OWNER_ID: string;
  CODER_USER_ID: string;
  SESSION_ID: string;
  CODER_URL: string;
  AUTH_SERVICE: { fetch: typeof fetch };
  CODER: { fetch: typeof fetch };
  ASSETS: TemplateAssets;
};
type Context = { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void };
function requireProof(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
export default {
  async fetch(request: Request, env: Env, ctx: Context) {
    if (
      new URL(request.url).pathname !== "/__local-publication" ||
      request.method !== "POST" ||
      request.headers.get("Authorization") !== `Bearer ${env.PROOF_BEARER}`
    )
      return new Response(null, { status: 404 });
    if (
      new URL(env.DATABASE_URL).hostname !== "127.0.0.1" ||
      !/^\/hive_template_workerd_[a-f0-9]{12}$/.test(new URL(env.DATABASE_URL).pathname) ||
      !/^\d+$/.test(env.WS_PORT)
    )
      return new Response(null, { status: 404 });
    neonConfig.wsProxy = () => `127.0.0.1:${env.WS_PORT}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineConnect = false;
    neonConfig.pipelineTLS = false;
    const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
      queryTimeoutMillis: 10000,
      transactionTimeoutMillis: 10000,
    });
    return runRequestLifetime(database, ctx, async () => {
      const checks: Record<string, boolean> = {},
        db = getDb();
      let stage = "database";
      try {
        requireProof(
          (await db.templatePublicationJob.count()) === 0,
          "fresh_local_database_required",
        );
        stage = "jobs_default_off";
        requireProof(
          (await dispatchScheduled({ HIVE_TEMPLATE_PUBLICATION_ENABLED: "false" })).enabled ===
            false,
          stage,
        );
        checks.defaultOffJobs = true;
        requireProof((await jobsWorker.fetch()).status === 404, "jobs_http_404");
        checks.actualJobsHttp404 = true;
        stage = "jobs_empty_wake";
        const empty = await dispatchScheduled({
          ...env,
          HIVE_TEMPLATE_PUBLICATION_ENABLED: "true",
        });
        requireProof(
          "templatePublications" in empty && empty.templatePublications?.claimed === 0,
          stage,
        );
        checks.actualJobsEmptyWake = true;
        await db.user.create({
          data: {
            id: env.OWNER_ID,
            coderUserId: env.CODER_USER_ID,
            coderUrl: env.CODER_URL,
            username: "synthetic",
            email: "synthetic@example.invalid",
          },
        });
        await db.session.create({
          data: {
            sessionId: env.SESSION_ID,
            userId: env.OWNER_ID,
            expiresAt: new Date(Date.now() + 3600000),
          },
        });
        const auth = publicationActorAuthorizer(publicationAuthClient(env)),
          load = templateAssetsLoader(env.ASSETS);
        stage = "asset_digest";
        const artifact = templatePublicationArtifact("ai-dev-k8s"),
          bytes = await load(artifact);
        requireProof(bytes.length === artifact.archiveBytes, stage);
        checks.actualAssetsDigestVerified = true;
        try {
          await load({ ...artifact, archiveDigest: "0".repeat(64) });
          throw new Error("unexpected_asset");
        } catch (error) {
          requireProof((error as { code?: string }).code === "artifact_changed", stage);
        }
        checks.changedAssetRejected = true;
        const actor = {
          ownerId: env.OWNER_ID,
          coderUserId: env.CODER_USER_ID,
          sessionId: env.SESSION_ID,
        };
        for (const mode of ["success", "version_unknown", "activation_unknown"]) {
          stage = mode;
          await env.CODER.fetch("https://synthetic.invalid/__fixture/config", {
            method: "POST",
            headers: { Authorization: `Bearer ${env.PROOF_BEARER}` },
            body: JSON.stringify({
              mode,
              templateId: crypto.randomUUID(),
              organizationId: crypto.randomUUID(),
              activeVersionId: crypto.randomUUID(),
            }),
          });
          const service = new TemplatePublicationService(db, {
            enabled: true,
            authorizeActor: auth,
            loadArtifact: load,
            provider: (a, s) =>
              CoderTemplatePublicationProvider.create(a, env.CODER.fetch.bind(env.CODER), s),
          });
          const job = await service.enqueue(actor, "ai-dev-k8s", crypto.randomUUID());
          for (let n = 0; n < (mode === "version_unknown" ? 3 : 4); n++) {
            await db.templatePublicationJob.update({
              where: { id: job.id },
              data: { nextAttemptAt: new Date(0) },
            });
            await service.processOne();
          }
          const stored = await service.store.read(actor.ownerId, "ai-dev-k8s", job.id);
          requireProof(stored, stage);
          const counts = (await (
            await env.CODER.fetch("https://synthetic.invalid/__fixture/counts", {
              headers: { Authorization: `Bearer ${env.PROOF_BEARER}` },
            })
          ).json()) as { uploads: number; versions: number; activations: number };
          requireProof(
            counts.uploads === 1 &&
              counts.versions === 1 &&
              counts.activations === (mode === "version_unknown" ? 0 : 1),
            stage,
          );
          requireProof(
            mode === "success"
              ? stored.stage === "succeeded"
              : stored.stage === "held" && stored.heldReason === mode,
            stage,
          );
          requireProof(
            !JSON.stringify(stored.events).includes("synthetic-secret") &&
              !JSON.stringify(stored.events).includes("synthetic-credential"),
            stage,
          );
          checks[mode] = true;
        }
        stage = "http_default_off";
        const routes = templatePublicationRoutes({
          enabled: () => false,
          session: async () => {
            throw new Error("must_not_authenticate");
          },
          service: () => {
            throw new Error("must_not_create");
          },
        });
        requireProof(
          (
            await routes.push(
              new Request("https://synthetic.invalid/path", { method: "POST" }),
              "ai-dev-k8s",
            )
          ).status === 404,
          stage,
        );
        checks.defaultOffBrowserRoute = true;
        return Response.json({
          passed: true,
          checks,
          provider: "synthetic service binding only",
          database: "isolated local PostgreSQL27",
        });
      } catch (error) {
        // Private local-only diagnostics; only synthetic fixture data exists here.
        console.error(String(error).slice(0, 1200));
        const e = error as { message?: unknown; error?: unknown; cause?: unknown };
        return Response.json(
          {
            passed: false,
            stage,
            checks,
            diagnostic: [String(error), String(e?.message), String(e?.error), String(e?.cause)]
              .join(" | ")
              .slice(0, 1200),
          },
          { status: 500 },
        );
      }
    });
  },
};
