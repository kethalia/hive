import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { configuredEpicMerge } from "./epic-merge-config.server";
import { createEpicMergeTestStore } from "./epic-merge-host.server";
import {
  configuredAutomaticRelease,
  createAutomaticReleaseTestStore,
} from "./release-automatic-host.server";
import {
  releaseTestAttestationSchema,
  releaseTestChallengeRequestSchema,
} from "./release-tested-attestation.server";
/** The producer endpoint has its own installation gate so it can issue the
 * tested-tree proof before a release or effectful controller exists. */
export function createInstalledReleaseTestStore(
  db: PrismaClient,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (env.HIVE_DELIVERY_RELEASE_TESTED_ENABLED === "true") {
    const automatic = configuredAutomaticRelease(env);
    if (automatic) return createAutomaticReleaseTestStore(db, automatic, fetcher);
  }
  const preview = configuredEpicMerge(env);
  if (preview) return createEpicMergeTestStore(db, preview, fetcher);
  if (
    env.HIVE_DELIVERY_RELEASE_ENABLED === "true" &&
    env.HIVE_DELIVERY_RELEASE_TESTED_ENABLED === "true"
  )
    throw Error("release_test_unavailable");
  return null;
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
