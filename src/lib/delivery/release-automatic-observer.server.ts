import { randomUUID } from "node:crypto";
import { boundedReleaseJson } from "../../../deploy/cloudflare/app/release-health";
import { githubSourceDigest } from "./github-evidence.server";
import {
  AUTOMATIC_HEALTH_PATH,
  type AutomaticReleaseConfig,
  automaticBuildsReadSchema,
  automaticHealthSchema,
} from "./release-automatic-contracts";
export type AutomaticBuildsReader = (sha: string, signal: AbortSignal) => Promise<unknown>;
export async function observeAutomaticBuild(
  config: AutomaticReleaseConfig,
  mergeSha: string,
  readBuilds: AutomaticBuildsReader,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  if (!/^[a-f0-9]{40}$/.test(mergeSha)) throw Error("automatic_observation_scope");
  const began = Date.now();
  const read = async () => {
    const nonce = randomUUID(),
      response = await fetcher(`${config.target.origin}${AUTOMATIC_HEALTH_PATH}`, {
        method: "GET",
        signal,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        headers: { "X-Hive-Health-Nonce": nonce, "Cache-Control": "no-cache" },
      });
    if (
      response.status !== 200 ||
      response.redirected ||
      !/(?:^|[,\s])no-store(?:[,\s]|$)/i.test(response.headers.get("Cache-Control") ?? "") ||
      response.headers.get("Content-Type")?.split(";")[0] !== "application/json"
    )
      throw Error("automatic_health_unverified");
    const health = automaticHealthSchema.parse(await boundedReleaseJson(response, 4096, signal));
    const observed = Date.parse(health.observedAt),
      now = Date.now();
    if (
      health.origin !== config.target.origin ||
      health.nonce !== nonce ||
      health.build.sourceSha !== mergeSha ||
      health.build.branch !== "main" ||
      observed < began - 5000 ||
      observed > now + 1000 ||
      now - observed >= 30000 ||
      signal.aborted
    )
      throw Error("automatic_health_unverified");
    return health;
  };
  const first = await read(),
    checks = automaticBuildsReadSchema.parse(await readBuilds(mergeSha, signal));
  if (checks.repositoryId !== config.policy.repositoryId || checks.sourceSha !== mergeSha)
    throw Error("automatic_build_unverified");
  const matching = checks.checks.filter((check) => {
    const url = new URL(check.detailsUrl);
    return (
      check.headSha === mergeSha &&
      check.buildUuid === first.build.buildUuid &&
      url.origin === "https://dash.cloudflare.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname ===
        `/${config.target.accountId}/workers/services/view/hive/production/builds/${check.buildUuid}`
    );
  });
  if (
    matching.length !== 1 ||
    matching[0].status !== "completed" ||
    matching[0].conclusion !== "success"
  )
    throw Error("automatic_build_unverified");
  const final = await read();
  if (
    githubSourceDigest(first.build) !== githubSourceDigest(final.build) ||
    signal.aborted ||
    Date.now() - began >= 30000
  )
    throw Error("automatic_observation_drift");
  return {
    schemaVersion: 1 as const,
    kind: "automatic-build-observation" as const,
    mergeSha,
    origin: config.target.origin,
    health: final,
    firstHealthDigest: githubSourceDigest(first),
    ...(checks.treeSha ? { treeSha: checks.treeSha } : {}),
    check: matching[0],
    coverage: "fixed-origin-db-auth-smoke" as const,
    observedAt: Date.now(),
    expiresAt: began + 30000,
  };
}
