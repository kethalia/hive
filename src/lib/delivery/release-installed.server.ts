import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { databaseCatalogSchema } from "../../../services/migrate/src/delivery/wire.mjs";
import { acceptedDatabasePlan } from "./database-job-store.server";
import { githubSourceDigest } from "./github-evidence.server";
import { configuredReleasePolicies } from "./release-authority.server";
import { ReleaseAutoOpener } from "./release-auto-open.server";
import { configuredAutomaticRelease } from "./release-automatic-host.server";
import { createAutomaticReleaseController } from "./release-automatic-installed.server";
import { GitHubReleaseChangeRisk } from "./release-change-risk.server";
import { CloudflareReleaseProvider } from "./release-cloudflare-provider.server";
import {
  createReleaseController,
  releaseControllerConfigSchema,
} from "./release-controller.server";
import { releaseDatabaseCompatibility } from "./release-database-compatibility.server";
import {
  ReleaseDatabaseObserver,
  verifyReleaseDatabaseDeployment,
} from "./release-database-observer.server";
import { verifyReleaseEvidence } from "./release-evidence.server";
import { ReleaseAuthorityFacts, verifyReleaseAuthorityFact } from "./release-facts.server";
import { releaseGitHubMerged } from "./release-github-merged.server";
import { releaseGitHubPreflight } from "./release-github-preflight.server";
import { GitHubReleaseRules } from "./release-github-rules.server";
import { CloudflareReleaseObserver } from "./release-observer.server";
import { releasePolicySchema } from "./release-policy-contracts";
import { ReleaseScheduler } from "./release-scheduler.server";
import { GitHubReleaseSourceDiscovery } from "./release-source-discovery.server";
import { createInstalledReleaseTestStore } from "./release-tested-installed.server";
import { repositoryPolicyStore } from "./repository-policy.server";

/** Deployment-owned construction. Flags, policies, risk catalog, credentials
 * and target never come from a task or HTTP body. No provider writes occur at
 * construction; the scheduler and route must separately be installed. */
export function createInstalledReleaseController(
  db: PrismaClient,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (env.HIVE_DELIVERY_RELEASE_ENABLED !== "true") return null;
  const raw = env.HIVE_DELIVERY_RELEASE_CONFIG_JSON;
  if (!raw || Buffer.byteLength(raw) > 32768) throw Error("release_controller_unavailable");
  const value = JSON.parse(raw);
  if (value?.mode === "automatic-main-builds") {
    const automatic = configuredAutomaticRelease(env);
    return automatic ? createAutomaticReleaseController(db, automatic, fetcher) : null;
  }
  const config = releaseControllerConfigSchema.parse(value);
  if (
    !config.authority ||
    !config.riskCatalog ||
    config.authority.targetDigest !== githubSourceDigest(config.target) ||
    config.authority.riskCatalogDigest !== githubSourceDigest(config.riskCatalog) ||
    config.riskCatalog.owner !== config.github.owner ||
    config.riskCatalog.name !== config.github.name
  )
    throw Error("release_controller_unavailable");
  const authorityDigest = githubSourceDigest(config.authority),
    policies = () => configuredReleasePolicies(env),
    store = repositoryPolicyStore(db);
  const testedStore = createInstalledReleaseTestStore(db, env, fetcher);
  if (!testedStore) throw Error("release_test_attestation_unavailable");
  const githubToken = env.HIVE_DELIVERY_RELEASE_GITHUB_TOKEN ?? "",
    cloudflareToken = env.HIVE_DELIVERY_RELEASE_CLOUDFLARE_TOKEN ?? "";
  const githubScope = { owner: config.github.owner, name: config.github.name };
  const rules = new GitHubReleaseRules(githubScope, githubToken, fetcher);
  const risk = new GitHubReleaseChangeRisk(config.riskCatalog, githubToken, fetcher);
  const provider = new CloudflareReleaseProvider(config.target, cloudflareToken, fetcher);
  const databaseEnabled =
    env.HIVE_DELIVERY_DATABASE_ENABLED === "true" &&
    env.HIVE_DELIVERY_RELEASE_DATABASE_OBSERVATION_ENABLED === "true";
  const databaseCatalogs = () => {
    const rawCatalogs = env.HIVE_DELIVERY_DATABASE_CATALOGS_JSON;
    if (!rawCatalogs || Buffer.byteLength(rawCatalogs) > 262144)
      throw Error("release_database_unavailable");
    return z.array(databaseCatalogSchema).max(32).parse(JSON.parse(rawCatalogs));
  };
  const databaseObserver = databaseEnabled ? new ReleaseDatabaseObserver(db, provider) : undefined;
  const observer = new CloudflareReleaseObserver(
    { target: config.target, ...config.observation },
    {
      analyticsToken: env.HIVE_DELIVERY_RELEASE_ANALYTICS_TOKEN ?? "",
      probeSecret: env.HIVE_RELEASE_PROBE_SECRET ?? "",
      previewBearer: env.PREVIEW_BEARER ?? "",
    },
    (component, signal) => provider.inspectCurrent(component, signal),
    fetcher,
  );
  const environment = {
    enabled: env.HIVE_DELIVERY_RELEASE_ENABLED,
    productionEnabled: env.HIVE_DELIVERY_RELEASE_PRODUCTION_ENABLED,
    configJson: raw,
    githubToken,
    cloudflareToken,
    analyticsToken: env.HIVE_DELIVERY_RELEASE_ANALYTICS_TOKEN,
    probeSecret: env.HIVE_RELEASE_PROBE_SECRET,
    previewBearer: env.PREVIEW_BEARER,
  };
  const basicPreflight = releaseGitHubPreflight(rules, risk);
  const controller = createReleaseController(
    db,
    environment,
    {
      repositoryPolicies: store,
      policies,
      resolveDatabasePin: async (tx, scope) => {
        if (!databaseEnabled) return null;
        const now = (
          await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
        )[0].now.getTime();
        const catalogs = databaseCatalogs().filter(
          (c) =>
            c.ownerId === scope.ownerId &&
            c.targetDigest === scope.targetDigest &&
            c.validFrom <= now &&
            c.expiresAt > now,
        );
        if (catalogs.length !== 1) return null;
        const plan = await acceptedDatabasePlan(tx, scope, catalogs[0]);
        return {
          catalogDigest: plan.catalogDigest,
          planEventId: plan.id,
          planDigest: plan.planDigest,
        };
      },
      verifyDatabase: databaseEnabled
        ? releaseDatabaseCompatibility(databaseCatalogs, (tx, context) =>
            verifyReleaseDatabaseDeployment(
              tx,
              context.ownerId,
              context.identity.releaseId,
              context.identity.id,
            ),
          )
        : undefined,
      verifyOpening: async (tx, scope) =>
        (await verifyReleaseEvidence(tx, store, {
          ...scope,
          milestone: "implementation_preview",
        })) &&
        verifyReleaseAuthorityFact(tx, {
          ...scope,
          configDigest: authorityDigest,
          factDigest: scope.riskAttestationDigest,
          fresh: true,
        }),
      verifyCurrent: async (tx, context) => {
        const rows = await tx.$queryRaw<
          { snapshot: unknown; phase: string | null }[]
        >`SELECT r.snapshot,a.phase FROM delivery_releases r LEFT JOIN delivery_release_actions a ON a.id=${context.identity.id}::uuid AND a.release_id=r.id WHERE r.id=${context.releaseId}::uuid`;
        if (rows.length !== 1) return false;
        const snapshot = z
          .object({ authorityConfigDigest: z.string() })
          .passthrough()
          .parse(rows[0].snapshot);
        if (
          snapshot.authorityConfigDigest !== authorityDigest ||
          !(await verifyReleaseEvidence(tx, store, {
            ...context,
            milestone: "implementation_preview",
          }))
        )
          return false;
        return verifyReleaseAuthorityFact(tx, {
          ownerId: context.ownerId,
          taskId: context.taskId,
          sourceSha: context.sourceSha,
          targetDigest: context.identity.targetDigest,
          configDigest: authorityDigest,
          factDigest: context.riskAttestationDigest,
          baselines: context.baselines,
          riskClass: context.riskClass,
          ...(context.identity.kind === "merge" ? { request: context.identity.request } : {}),
          // Opening needs a fresh fact. Dispatch separately re-reads rules,
          // base and changed paths immediately before the provider request;
          // retaining historical facts lets a crash before prepare resume.
          fresh: false,
        });
      },
      verifyBeforeMerge: async (request, signal) => {
        try {
          if (!(await basicPreflight(request, signal))) return false;
          const now = Date.now();
          const active = z
            .array(releasePolicySchema)
            .max(32)
            .parse(policies())
            .filter(
              (p) =>
                p.repositoryId === request.repositoryId &&
                p.targetDigest === config.authority?.targetDigest &&
                p.authorityConfigDigest === authorityDigest &&
                p.actions.includes("merge") &&
                p.validFrom <= now &&
                p.expiresAt > now,
            );
          if (active.length !== 1) return false;
          const rows = await db.deliveryTask.findMany({
            where: {
              ownerId: active[0].ownerId,
              currentSourceRevision: {
                is: {
                  repositoryId: request.repositoryId,
                  pullRequestId: request.pullRequestId,
                  headSha: request.headSha,
                },
              },
            },
            select: { ownerId: true, id: true },
            take: 2,
          });
          if (rows.length !== 1) return false;
          const bound = await db.$transaction((tx) =>
            store.resolveTask(tx, rows[0].ownerId, rows[0].id),
          );
          if (!bound || bound.task.sourceSha !== request.headSha) return false;
          const tested = await rules.verifyTested(request, bound.policy.evidenceGates, signal);
          if (tested.rulesDigest !== request.rulesDigest) return false;
          await testedStore.verifyFresh(rows[0].ownerId, rows[0].id, request, signal);
          return !signal.aborted;
        } catch {
          return false;
        }
      },
      verifyMerged: releaseGitHubMerged(githubScope, githubToken, fetcher),
    },
    fetcher,
  );
  if (!controller) throw Error("release_controller_unavailable");
  const facts = new ReleaseAuthorityFacts(
    db,
    config.authority,
    store,
    policies,
    rules,
    risk,
    provider,
    observer,
    testedStore,
  );
  const discovery = new GitHubReleaseSourceDiscovery(
    {
      ...githubScope,
      repositoryId: config.github.repositoryId,
      baseRef: config.github.allowedBaseRef,
      method: config.authority.mergeMethod,
    },
    githubToken,
    rules,
    fetcher,
  );
  const opener = new ReleaseAutoOpener(
    db,
    config.authority.targetDigest,
    authorityDigest,
    store,
    policies,
    discovery,
    facts,
    controller.lifecycle,
  );
  return {
    ...controller,
    facts,
    opener,
    scheduler: new ReleaseScheduler(
      db,
      config.authority.targetDigest,
      controller,
      controller.planner,
      opener,
      databaseObserver,
    ),
  };
}
