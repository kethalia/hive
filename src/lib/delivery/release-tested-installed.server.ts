import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { configuredEpicMerge } from "./epic-merge-config.server";
import { createEpicMergeTestStore } from "./epic-merge-host.server";
import { githubSourceDigest } from "./github-evidence.server";
import { configuredReleasePolicies } from "./release-authority.server";
import {
  configuredAutomaticRelease,
  createAutomaticReleaseTestStore,
} from "./release-automatic-host.server";
import { GitHubReleaseChangeRisk } from "./release-change-risk.server";
import { releaseControllerConfigSchema } from "./release-controller.server";
import { GitHubReleaseRules } from "./release-github-rules.server";
import {
  releaseTestAttestationSchema,
  releaseTestChallengeRequestSchema,
} from "./release-tested-attestation.server";
import { GitHubReleaseTestRunVerifier } from "./release-tested-run.server";
import { ReleaseTestStore } from "./release-tested-store.server";
import { repositoryPolicyStore } from "./repository-policy.server";
/** The producer endpoint has its own installation gate so it can issue the
 * tested-tree proof before a release or effectful controller exists. */
export function createInstalledReleaseTestStore(
  db: PrismaClient,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (
    env.HIVE_DELIVERY_RELEASE_ENABLED === "true" &&
    env.HIVE_DELIVERY_RELEASE_TESTED_ENABLED === "true" &&
    env.HIVE_DELIVERY_RELEASE_CONFIG_JSON &&
    JSON.parse(env.HIVE_DELIVERY_RELEASE_CONFIG_JSON)?.mode === "automatic-main-builds"
  ) {
    const automatic = configuredAutomaticRelease(env);
    return automatic ? createAutomaticReleaseTestStore(db, automatic, fetcher) : null;
  }
  if (
    env.HIVE_DELIVERY_RELEASE_ENABLED !== "true" ||
    env.HIVE_DELIVERY_RELEASE_TESTED_ENABLED !== "true"
  ) {
    const preview = configuredEpicMerge(env);
    return preview ? createEpicMergeTestStore(db, preview, fetcher) : null;
  }
  const raw = env.HIVE_DELIVERY_RELEASE_CONFIG_JSON;
  if (!raw || Buffer.byteLength(raw) > 32768) throw Error("release_test_unavailable");
  const config = releaseControllerConfigSchema.parse(JSON.parse(raw));
  if (
    !config.authority?.tested ||
    !config.riskCatalog ||
    config.authority.targetDigest !== githubSourceDigest(config.target) ||
    config.authority.riskCatalogDigest !== githubSourceDigest(config.riskCatalog) ||
    config.riskCatalog.owner !== config.github.owner ||
    config.riskCatalog.name !== config.github.name ||
    config.authority.tested.workflow.repositoryId !== config.github.repositoryId ||
    config.authority.tested.run.repositoryId !== config.github.repositoryId ||
    config.authority.tested.run.owner !== config.github.owner ||
    config.authority.tested.run.name !== config.github.name
  )
    throw Error("release_test_unavailable");
  const token = env.HIVE_DELIVERY_RELEASE_GITHUB_TOKEN ?? "",
    scope = { owner: config.github.owner, name: config.github.name };
  return new ReleaseTestStore(
    db,
    config.authority.tested.workflow,
    new GitHubReleaseTestRunVerifier(config.authority.tested.run, token, fetcher),
    repositoryPolicyStore(db),
    () => configuredReleasePolicies(env),
    config.authority.targetDigest,
    githubSourceDigest(config.authority),
    new GitHubReleaseRules(scope, token, fetcher),
    new GitHubReleaseChangeRisk(config.riskCatalog, token, fetcher),
    fetcher,
  );
}

/** Purpose selection is derived from the exact persisted source. A request
 * cannot choose the preview policy merely by naming a branch or purpose. */
export async function createInstalledReleaseTestStoreForRequest(
  db: PrismaClient,
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
) {
  const input = z
    .union([releaseTestChallengeRequestSchema, releaseTestAttestationSchema])
    .parse(raw);
  const automatic = configuredAutomaticRelease(env);
  if (automatic && automatic.policy.repositoryId === input.repositoryId) {
    const tasks = await db.deliveryTask.findMany({
      where: {
        ownerId: automatic.policy.ownerId,
        currentSourceRevision: {
          is: {
            repositoryId: input.repositoryId,
            pullNumber: input.pullNumber,
            headSha: input.headSha,
            baseBranch: "main",
          },
        },
      },
      take: 2,
    });
    if (tasks.length > 1) throw Error("release_test_scope");
    if (tasks.length === 1) return createAutomaticReleaseTestStore(db, automatic, fetcher);
  }
  const preview = configuredEpicMerge(env);
  if (preview && preview.policy.repositoryId === input.repositoryId) {
    const tasks = await db.deliveryTask.findMany({
      where: {
        ownerId: preview.policy.ownerId,
        currentSourceRevision: {
          is: {
            repositoryId: input.repositoryId,
            pullNumber: input.pullNumber,
            headSha: input.headSha,
          },
        },
      },
      include: { currentSourceRevision: true },
      take: 2,
    });
    if (tasks.length > 1) throw Error("release_test_scope");
    if (tasks[0]?.currentSourceRevision?.baseBranch === preview.policy.baseBranch)
      return createEpicMergeTestStore(db, preview, fetcher);
  }
  return createInstalledReleaseTestStore(db, env, fetcher);
}
