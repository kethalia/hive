import { randomUUID } from "node:crypto";
import type { Prisma } from "@hive/db";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";

type Tx = Prisma.TransactionClient;
/** Called only inside the same transaction as the durable release transition. */
export async function appendReleaseNotice(
  tx: Tx,
  input: {
    ownerId: string;
    taskId: string;
    releaseId: string;
    aggregateKey: string;
    aggregateVersion: number;
    type: "release_action_held" | "release_healthy" | "release_regression" | "release_recovered";
    evidenceDigest?: string;
  },
) {
  const eventId = randomUUID(),
    payload = {
      releaseId: input.releaseId,
      ...(input.evidenceDigest ? { evidenceDigest: input.evidenceDigest } : {}),
    };
  const requestDigest = githubSourceDigest({ type: input.type, payload });
  await tx.$executeRaw`INSERT INTO delivery_events(id,owner_id,task_id,aggregate_key,aggregate_version,schema_version,policy_version,type,request_digest,payload)
    VALUES (${eventId}::uuid,${input.ownerId}::uuid,${input.taskId}::uuid,${input.aggregateKey},${input.aggregateVersion},1,'release-v1',${input.type},${requestDigest},${canonicalGitHubSource(payload)}::jsonb)`;
  await tx.$executeRaw`INSERT INTO delivery_outbox(id,owner_id,event_id,channel) VALUES (${randomUUID()}::uuid,${input.ownerId}::uuid,${eventId}::uuid,'push')`;
}
