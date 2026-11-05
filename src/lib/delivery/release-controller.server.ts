import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { createReleaseAuthorizer } from "./release-authority.server";
import { releaseBaselinesSchema } from "./release-baseline-contracts";
import { releaseBuildWorkflowSchema } from "./release-build-attestation.server";
import { GitHubBuildRunVerifier, releaseBuildRunConfigSchema } from "./release-build-run.server";
import { ReleaseBuildStore } from "./release-build-store.server";
import {
  CloudflareReleaseProvider,
  cloudflareReleaseTargetSchema,
  releaseTargetResources,
} from "./release-cloudflare-provider.server";
import { PostgresReleaseEffectJournal } from "./release-effect-journal.server";
import { ReleaseEffectRunner } from "./release-effect-runner.server";
import { GitHubReleaseProvider } from "./release-github-provider.server";
import { ReleaseLifecycle } from "./release-lifecycle.server";
import { ReleaseObservationController } from "./release-observation-controller.server";
import { CloudflareReleaseObserver } from "./release-observer.server";
import { ReleasePlanner } from "./release-planner.server";
import { releasePolicySchema } from "./release-policy-contracts";
import { ReleaseScheduler } from "./release-scheduler.server";
import { releaseTestWorkflowSchema } from "./release-tested-attestation.server";
import { releaseTestRunConfigSchema } from "./release-tested-run.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";

const uuid = z.string().uuid();
export const releaseControllerConfigSchema = z
  .object({
    target: cloudflareReleaseTargetSchema.refine((t) =>
      ["preview", "production"].includes(t.environment),
    ),
    github: z
      .object({
        repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
        owner: z.string(),
        name: z.string(),
        allowedBaseRef: z.string(),
      })
      .strict(),
    build: z
      .object({
        workflow: releaseBuildWorkflowSchema,
        run: releaseBuildRunConfigSchema,
        publisherConfigDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    authority: z
      .object({
        targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
        riskCatalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
        mergeMethod: z.enum(["merge", "squash", "rebase"]),
        baselines: releaseBaselinesSchema,
        tested: z
          .object({ workflow: releaseTestWorkflowSchema, run: releaseTestRunConfigSchema })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    riskCatalog: z
      .object({
        owner: z.string(),
        name: z.string(),
        allowedPrefixes: z.array(z.string()),
        databasePrefixes: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    observation: z
      .object({
        origin: z.string(),
        minimumRequests: z.number(),
        maxErrorRate: z.number(),
        settleDelayMs: z.number(),
      })
      .strict(),
  })
  .strict();

type LifecycleOptions = ConstructorParameters<typeof ReleaseLifecycle>[1];
type AuthorityOptions = Parameters<typeof createReleaseAuthorizer>[0];
type GitHubBefore = ConstructorParameters<typeof GitHubReleaseProvider>[2];
type GitHubMerged = ConstructorParameters<typeof GitHubReleaseProvider>[3];

/** Inert unless explicitly enabled with a deployment catalog and all
 * independently implemented verifiers. Production also requires a separate
 * operator-controlled enable flag. There is no credential fallback, browser
 * route or model-selected endpoint. Source/risk,
 * review/CI, merged build attestation and compatibility are separate authorities
 * supplied by the deployment; missing implementations prevent construction. */
export function createReleaseController(
  db: PrismaClient,
  environment: {
    enabled?: string;
    productionEnabled?: string;
    configJson?: string;
    githubToken?: string;
    cloudflareToken?: string;
    analyticsToken?: string;
    probeSecret?: string;
    previewBearer?: string;
  },
  dependencies: {
    repositoryPolicies: RepositoryPolicyStore;
    policies: AuthorityOptions["policies"];
    verifyCurrent: AuthorityOptions["verifyCurrent"];
    verifyOpening: LifecycleOptions["verifyOpening"];
    resolveDatabasePin?: LifecycleOptions["resolveDatabasePin"];
    verifyDatabase?: AuthorityOptions["verifyDatabase"];
    verifyBeforeMerge: GitHubBefore;
    verifyMerged: GitHubMerged;
  },
  fetcher: typeof fetch = fetch,
) {
  if (environment.enabled !== "true") return null;
  if (!environment.configJson || Buffer.byteLength(environment.configJson) > 32768)
    throw new Error("release_controller_unavailable");
  const config = releaseControllerConfigSchema.parse(JSON.parse(environment.configJson));
  const mode = config.target.environment;
  if (
    (mode === "production" && environment.productionEnabled !== "true") ||
    (config.build.workflow.mode ?? "preview") !== mode ||
    (mode === "production" && config.build.workflow.productionEnabled !== true)
  )
    throw new Error("release_environment_not_enabled");
  if (
    ![
      dependencies.policies,
      dependencies.verifyCurrent,
      dependencies.verifyOpening,
      dependencies.verifyBeforeMerge,
      dependencies.verifyMerged,
    ].every((fn) => typeof fn === "function")
  )
    throw new Error("release_controller_unavailable");
  const github = new GitHubReleaseProvider(
    { ...config.github, mode, productionEnabled: environment.productionEnabled === "true" },
    environment.githubToken ?? "",
    dependencies.verifyBeforeMerge,
    dependencies.verifyMerged,
    fetcher,
  );
  const cloudflare = new CloudflareReleaseProvider(
    config.target,
    environment.cloudflareToken ?? "",
    fetcher,
  );
  const buildRun = new GitHubBuildRunVerifier(
    config.build.run,
    environment.githubToken ?? "",
    fetcher,
  );
  const observer = new CloudflareReleaseObserver(
    { target: config.target, ...config.observation },
    {
      analyticsToken: environment.analyticsToken ?? "",
      probeSecret: environment.probeSecret ?? "",
      previewBearer: environment.previewBearer ?? "",
    },
    (component, signal) => cloudflare.inspectCurrent(component, signal),
    fetcher,
  );
  const policies = () =>
    z
      .array(releasePolicySchema)
      .max(32)
      .parse(dependencies.policies())
      .filter(
        (policy) =>
          policy.targetDigest === githubSourceDigest(config.target) &&
          canonicalGitHubSource(policy.targetResources) ===
            canonicalGitHubSource(releaseTargetResources(config.target)) &&
          policy.observationConfigDigest === observer.configDigest() &&
          policy.repositoryId === config.github.repositoryId &&
          policy.buildAuthorityDigest === githubSourceDigest(config.build) &&
          config.authority !== undefined &&
          policy.authorityConfigDigest === githubSourceDigest(config.authority) &&
          config.build.run.repositoryId === config.github.repositoryId &&
          config.build.workflow.repositoryId === config.github.repositoryId &&
          config.build.workflow.branchRef === `refs/heads/${config.github.allowedBaseRef}`,
      );
  const authorize = createReleaseAuthorizer({
    repositoryPolicies: dependencies.repositoryPolicies,
    policies,
    productionEnabled: mode === "production" && environment.productionEnabled === "true",
    verifyCurrent: dependencies.verifyCurrent,
    verifyDatabase: dependencies.verifyDatabase,
  });
  const factory = (verifyObservation: LifecycleOptions["verifyObservation"]) =>
    new ReleaseLifecycle(db, {
      repositoryPolicies: dependencies.repositoryPolicies,
      policies,
      productionEnabled: mode === "production" && environment.productionEnabled === "true",
      verifyOpening: dependencies.verifyOpening,
      resolveDatabasePin: dependencies.resolveDatabasePin,
      verifyAction: authorize,
      verifyObservation,
    });
  const observation = new ReleaseObservationController(db, observer, authorize, factory);
  const builds = new ReleaseBuildStore(
    db,
    config.build.workflow,
    cloudflare,
    authorize,
    buildRun,
    fetcher,
    githubSourceDigest(config.target),
    config.build.publisherConfigDigest,
  );
  const controller = {
    // Only trusted controller code can obtain this object; callers must derive
    // immutable request bodies from persisted evidence before invoking it.
    lifecycle: factory(async () => false),
    builds,
    async step(ownerId: string, actionId: string, signal: AbortSignal) {
      uuid.parse(ownerId);
      uuid.parse(actionId);
      const rows = await db.$queryRaw<
        { kind: string }[]
      >`SELECT a.kind FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id WHERE a.id=${actionId}::uuid AND r.owner_id=${ownerId}::uuid`;
      if (!rows.length) return "not_found" as const;
      const provider =
        rows[0].kind === "merge"
          ? github
          : ["promote", "recover"].includes(rows[0].kind)
            ? cloudflare
            : null;
      if (!provider) throw new Error("release_action_kind_invalid");
      const runner = new ReleaseEffectRunner(
        new PostgresReleaseEffectJournal(db, ownerId, authorize),
        provider,
      );
      const result = await runner.dispatch(actionId, signal);
      return result === "not_started" ? runner.reconcile(actionId, signal) : result;
    },
    observe(ownerId: string, releaseId: string, signal: AbortSignal) {
      return observation.observe(ownerId, releaseId, signal);
    },
  };
  const planner = new ReleasePlanner(db, githubSourceDigest(config.target), controller.lifecycle);
  return {
    ...controller,
    planner,
    scheduler: new ReleaseScheduler(db, githubSourceDigest(config.target), controller, planner),
  };
}
