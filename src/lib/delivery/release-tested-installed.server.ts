import type { PrismaClient } from "@hive/db";
import { githubSourceDigest } from "./github-evidence.server";
import { configuredReleasePolicies } from "./release-authority.server";
import { GitHubReleaseChangeRisk } from "./release-change-risk.server";
import { releaseControllerConfigSchema } from "./release-controller.server";
import { GitHubReleaseRules } from "./release-github-rules.server";
import { createNativePreviewReleaseController } from "./release-native-preview-controller.server";
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
    env.HIVE_DELIVERY_RELEASE_ENABLED !== "true" ||
    env.HIVE_DELIVERY_RELEASE_TESTED_ENABLED !== "true"
  )
    return null;
  const raw = env.HIVE_DELIVERY_RELEASE_CONFIG_JSON;
  if (!raw || Buffer.byteLength(raw) > 32768) throw Error("release_test_unavailable");
  const candidate = JSON.parse(raw);
  if (candidate.provider === "cloudflare-native-preview")
    return createNativePreviewReleaseController(db, env, fetcher)?.tested ?? null;
  const config = releaseControllerConfigSchema.parse(candidate);
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
