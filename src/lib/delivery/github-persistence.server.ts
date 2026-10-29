import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import type { CheckEvidence, ReviewEvidence, RevisionEvidence } from "./eligibility";
import {
  type GitHubSourceTarget,
  githubBotReviewProducer,
  githubCheckProducer,
  githubEvidencePolicySchema,
  githubFormalReviewProducer,
} from "./github-contracts";
import {
  canonicalGitHubSource,
  GitHubEvidenceAdapter,
  type GitHubSourceConnection,
  githubSourceDigest,
} from "./github-evidence.server";
import { resolveTaskSource } from "./source-resolver.server";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
export interface AuthorizedGitHubSource extends GitHubSourceConnection {
  /** Mandatory SAME-transaction source authority. Lock active registration and
   * verify the controller-issued target/nonce/snapshot digest receipt. A manager
   * boolean or a host's self-asserted JSON must never implement this callback. */
  authorizeTransaction(
    tx: Tx,
    binding: {
      ownerId: string;
      taskId: string;
      stepId: string;
      target: GitHubSourceTarget;
      snapshotDigest: string;
      policyDigest: string;
    },
  ): Promise<void>;
}
export interface ImmutableGitHubArtifactStore {
  /** Write immutable bytes and verify the stored digest/length before returning.
   * No local-memory or database-only production fallback is provided. */
  writeAndVerify(
    key: string,
    content: Uint8Array,
    digest: string,
  ): Promise<{ contentDigest: string; size: number }>;
}
const uid = (text: string) => {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
export const githubEvidenceProducer = (repositoryId: string, policy: unknown) =>
  `github-source-v1:${repositoryId}:${githubSourceDigest(githubEvidencePolicySchema.parse(policy))}`;
const versionSchema = z
  .object({
    runSequence: z.number().int().nonnegative(),
    runAttempt: z.number().int().positive(),
    sourceUpdatedAt: z.number().finite(),
  })
  .strict();
const watermarkSchema = z
  .object({
    key: z.string(),
    version: versionSchema.nullable(),
    stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    conflict: z.boolean(),
  })
  .strict();
const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
    policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: z.string(),
    watermarks: z.array(watermarkSchema).max(100),
    evidenceIds: z
      .array(z.string().uuid())
      .min(1)
      .max(40)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
type Watermark = z.infer<typeof watermarkSchema>;
type Group = {
  key: string;
  kind: "check" | "review";
  criterionIds: string[];
  status: "passed" | "failed" | "unknown";
  mark: Watermark;
};
const compare = (a: z.infer<typeof versionSchema>, b: z.infer<typeof versionSchema>) =>
  a.runSequence - b.runSequence ||
  a.runAttempt - b.runAttempt ||
  a.sourceUpdatedAt - b.sourceUpdatedAt;
export function isGitHubSerializationConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    name?: unknown;
    code?: unknown;
    clientVersion?: unknown;
    meta?: { code?: unknown };
  };
  if (
    value.name !== "PrismaClientKnownRequestError" ||
    typeof value.clientVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value.clientVersion)
  )
    return false;
  // Node Prisma reports SQL 40001 thrown by SELECT ... FOR UPDATE as P2010,
  // distinct from its P2034 interactive-transaction serialization failure.
  return value.code === "P2034" || (value.code === "P2010" && value.meta?.code === "40001");
}
function group(
  key: string,
  kind: "check" | "review",
  criterionIds: string[],
  values: (CheckEvidence | ReviewEvidence)[],
  now: number,
  maxAge: number,
): Group {
  const latest = values.reduce<RevisionEvidence | null>(
    (best, value) => (!best || compare(value, best) > 0 ? value : best),
    null,
  );
  const current = latest ? values.filter((value) => compare(value, latest) === 0) : [];
  const passed =
    current.length > 0 &&
    current.every(
      (value) =>
        value.verified &&
        value.sourceUpdatedAt <= value.observedAt &&
        value.observedAt <= now &&
        now - value.observedAt <= maxAge &&
        (kind === "check"
          ? value.status === "success"
          : value.status === "completed" &&
            (value as ReviewEvidence).independent &&
            (value as ReviewEvidence).unresolvedFindings === 0),
    );
  const failed = current.some(
    (value) =>
      (kind === "check" && ["failure", "skipped"].includes(value.status)) ||
      (kind === "review" && (value as ReviewEvidence).unresolvedFindings > 0),
  );
  const state = current
    .map(({ observedAt: _observedAt, ...value }) => canonicalGitHubSource(value))
    .sort();
  return {
    key,
    kind,
    criterionIds,
    status: passed ? "passed" : failed ? "failed" : "unknown",
    mark: {
      key,
      version: latest
        ? {
            runSequence: latest.runSequence,
            runAttempt: latest.runAttempt,
            sourceUpdatedAt: latest.sourceUpdatedAt,
          }
        : null,
      stateDigest: githubSourceDigest(state),
      conflict: false,
    },
  };
}

/** Internal controller capability only. No HTTP route or manager producer scope.
 * Every source update supersedes all relevant older references atomically; an
 * accepted historic report remains immutable and cannot authorize a release. */
export class GitHubEvidencePublisher {
  constructor(
    private readonly db: PrismaClient,
    private readonly source: AuthorizedGitHubSource,
    private readonly artifacts: ImmutableGitHubArtifactStore,
    private readonly clock = () => Date.now(),
  ) {}
  async publish(
    ownerInput: string,
    taskId: string,
    stepId: string,
    pullNumber: number,
    policyInput: unknown,
  ) {
    const ownerId = z.string().uuid().parse(ownerInput);
    z.string().uuid().parse(taskId);
    z.string().uuid().parse(stepId);
    const task = await this.db.deliveryTask.findUnique({
      where: { ownerId_id: { ownerId, id: taskId } },
      include: { project: true, steps: { where: { id: stepId } } },
    });
    if (!task || task.project.provider !== "github" || task.steps.length !== 1)
      throw new DeliveryConflict("github_task_not_found");
    await resolveTaskSource(this.db, ownerId, taskId);
    const observation = await new GitHubEvidenceAdapter(this.source, this.clock).observe(
      {
        schemaVersion: 1,
        providerRepositoryId: task.project.providerRepositoryId,
        providerAccountId: task.project.providerAccountId,
        fullName: task.project.fullName,
        pullNumber,
        expectedHeadSha: task.sourceSha,
      },
      policyInput,
      task.pauseRequested || task.schedulingPaused,
    );
    const { snapshot, target, policy } = observation,
      producer = githubEvidenceProducer(target.providerRepositoryId, policy);
    const policyDigest = githubSourceDigest(policy);
    const codex = policy.codexReview;
    const groups: Group[] = [
      ...policy.checks.map((check) => {
        const expected = githubCheckProducer(
          target.providerRepositoryId,
          check.workflowId,
          check.appId,
        );
        return group(
          `${expected}/${check.name}`,
          "check",
          check.criterionIds,
          observation.checks.filter(
            (value) => value.producer === expected && value.name === check.name,
          ),
          this.clock(),
          policy.maxAgeMs,
        );
      }),
      ...(codex
        ? [
            group(
              githubBotReviewProducer(target.providerRepositoryId, codex.userId, codex.appId),
              "review",
              codex.criterionIds,
              observation.reviews.filter(
                (value) =>
                  value.producer ===
                  githubBotReviewProducer(target.providerRepositoryId, codex.userId, codex.appId),
              ),
              this.clock(),
              policy.maxAgeMs,
            ),
          ]
        : []),
      ...policy.formalReviewers.map((review) =>
        group(
          githubFormalReviewProducer(target.providerRepositoryId, review.userId),
          "review",
          review.criterionIds,
          observation.reviews.filter(
            (value) =>
              value.producer ===
              githubFormalReviewProducer(target.providerRepositoryId, review.userId),
          ),
          this.clock(),
          policy.maxAgeMs,
        ),
      ),
    ];
    if (
      groups.some((group) =>
        group.criterionIds.some((id) => !task.steps[0].criterionIds.includes(id)),
      )
    )
      throw new DeliveryConflict("github_criterion_binding_mismatch");
    // PR admission has its own authoritative update clock. Mixing this into a
    // workflow's run sequence would misorder source updates with unchanged SHA.
    for (const kind of ["check", "review"] as const) {
      const criterionIds = [
        ...new Set(
          groups.filter((value) => value.kind === kind).flatMap((value) => value.criterionIds),
        ),
      ];
      if (!criterionIds.length) continue;
      const key = `github-pr:${target.providerRepositoryId}:${snapshot.pullRequest.id}:${kind}`;
      const sourceUpdatedAt = Date.parse(snapshot.pullRequest.updatedAt);
      groups.push({
        key,
        kind,
        criterionIds,
        status:
          snapshot.pullRequest.state === "open" &&
          !snapshot.pullRequest.draft &&
          sourceUpdatedAt <= Date.parse(snapshot.observedAt)
            ? "passed"
            : "unknown",
        mark: {
          key,
          version: { runSequence: 0, runAttempt: 1, sourceUpdatedAt },
          stateDigest: githubSourceDigest(snapshot.pullRequest),
          conflict: false,
        },
      });
    }
    const object = { schemaVersion: 1, source: "github", target, policy, snapshot };
    const content = Buffer.from(canonicalGitHubSource(object)),
      contentDigest = githubSourceDigest(object);
    const objectKey = `delivery/${ownerId}/github/${target.providerRepositoryId}/${target.expectedHeadSha}/${contentDigest}.json`;
    const receipt = await this.artifacts.writeAndVerify(objectKey, content, contentDigest);
    if (receipt.contentDigest !== contentDigest || receipt.size !== content.length)
      throw new DeliveryConflict("github_artifact_unverified");
    const eventId = uid(`${ownerId}/${stepId}/${producer}/${contentDigest}`),
      aggregateKey = `github-evidence/${stepId}`;
    for (let retry = 0; ; retry++) {
      try {
        return await this.db.$transaction(
          async (tx) => {
            await this.source.authorizeTransaction(tx, {
              ownerId,
              taskId,
              stepId,
              target,
              snapshotDigest: observation.contentDigest,
              policyDigest,
            });
            const rows = await tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM delivery_tasks WHERE owner_id=${ownerId}::uuid AND id=${taskId}::uuid FOR UPDATE`;
            if (rows.length !== 1) throw new DeliveryConflict("github_task_not_found");
            const current = await tx.deliveryTask.findUniqueOrThrow({
              where: { ownerId_id: { ownerId, id: taskId } },
              include: { project: true },
            });
            await resolveTaskSource(tx, ownerId, taskId);
            const step = await tx.deliveryStep.findUnique({
              where: { ownerId_taskId_id: { ownerId, taskId, id: stepId } },
            });
            if (
              !step ||
              current.sourceSha !== target.expectedHeadSha ||
              current.projectId !== task.projectId ||
              current.project.providerRepositoryId !== target.providerRepositoryId ||
              current.project.providerAccountId !== target.providerAccountId
            )
              throw new DeliveryConflict("github_source_binding_mismatch");
            const replay = await tx.deliveryEvent.findUnique({
              where: { ownerId_id: { ownerId, id: eventId } },
            });
            if (replay) {
              const payload = payloadSchema.parse(replay.payload);
              const persisted = await tx.deliveryEvidence.findMany({
                where: { ownerId, stepId, id: { in: payload.evidenceIds } },
                select: { status: true, invalidatedAt: true },
              });
              if (
                payload.policyDigest !== policyDigest ||
                persisted.length !== payload.evidenceIds.length
              )
                throw new DeliveryConflict("github_evidence_incomplete");
              const unsafe = persisted.some(
                (row) => row.status !== "passed" || row.invalidatedAt !== null,
              );
              return {
                eventId,
                evidenceIds: payload.evidenceIds,
                replayed: true,
                eligibility:
                  unsafe || payload.watermarks.some((mark) => mark.conflict)
                    ? {
                        ...observation.eligibility,
                        eligible: false,
                        blockers: [
                          ...observation.eligibility.blockers,
                          "persisted-source-not-current",
                        ],
                      }
                    : observation.eligibility,
              };
            }
            const previous = await tx.deliveryEvent.findFirst({
              where: { ownerId, taskId, aggregateKey },
              orderBy: { aggregateVersion: "desc" },
            });
            const prior = previous ? payloadSchema.parse(previous.payload) : null;
            const previousMarks = new Map(prior?.watermarks.map((mark) => [mark.key, mark]) ?? []);
            const effective = structuredClone(groups);
            const policyChanged = prior !== null && prior.policyDigest !== policyDigest;
            const groupSetChanged =
              prior !== null &&
              canonicalGitHubSource(prior.watermarks.map((mark) => mark.key).sort()) !==
                canonicalGitHubSource(effective.map((value) => value.key).sort());
            let semanticChange = policyChanged || groupSetChanged;
            for (const value of effective) {
              const old = previousMarks.get(value.key);
              if (!old) {
                semanticChange = true;
                continue;
              }
              const order =
                old.version && value.mark.version ? compare(value.mark.version, old.version) : null;
              if (order !== null && order < 0)
                throw new DeliveryConflict("github_observation_stale");
              if (
                (old.version && value.mark.version === null) ||
                (order === 0 && (old.conflict || old.stateDigest !== value.mark.stateDigest))
              ) {
                value.status = "unknown";
                value.mark = {
                  ...value.mark,
                  version: old.version,
                  conflict: true,
                  stateDigest: githubSourceDigest([old.stateDigest, value.mark.stateDigest].sort()),
                };
              }
              if (old.stateDigest !== value.mark.stateDigest || order !== 0) semanticChange = true;
            }
            const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]
              .now;
            if (
              Date.parse(snapshot.observedAt) > now.getTime() ||
              now.getTime() - Date.parse(snapshot.observedAt) > policy.maxAgeMs
            )
              throw new DeliveryConflict("github_observation_expired");
            const oldEvidence = semanticChange
              ? await tx.deliveryEvidence.findMany({
                  where: {
                    ownerId,
                    stepId,
                    sourceSha: target.expectedHeadSha,
                    producer: { startsWith: `github-source-v1:${target.providerRepositoryId}:` },
                    invalidatedAt: null,
                  },
                  select: { id: true, status: true },
                })
              : [];
            if (oldEvidence.length)
              await tx.deliveryEvidence.updateMany({
                where: {
                  ownerId,
                  id: { in: oldEvidence.map((value) => value.id) },
                  invalidatedAt: null,
                },
                data: { invalidatedAt: now },
              });
            const evidenceIds: string[] = [];
            for (const kind of ["check", "review"] as const) {
              for (const criterion of step.criterionIds) {
                const relevant = effective.filter(
                  (value) => value.kind === kind && value.criterionIds.includes(criterion),
                );
                if (!relevant.length) continue;
                const status = relevant.every((value) => value.status === "passed")
                  ? "passed"
                  : relevant.some((value) => value.status === "failed")
                    ? "failed"
                    : "unknown";
                const remoteId = `${target.providerRepositoryId}/${snapshot.pullRequest.id}/${kind}/${githubSourceDigest(criterion).slice(0, 16)}/${contentDigest}`;
                const id = uid(`${ownerId}/${stepId}/${producer}/${remoteId}`);
                const record = {
                  id,
                  ownerId,
                  stepId,
                  producer,
                  remoteId,
                  policyVersion: policy.version,
                  kind,
                  status,
                  verificationMode: "integration",
                  environment: "github.com",
                  sourceSha: target.expectedHeadSha,
                  criterionIds: [criterion],
                  objectKey,
                  contentDigest,
                  observedAt: new Date(snapshot.observedAt),
                };
                await tx.deliveryEvidence.create({
                  data: { ...record, requestDigest: githubSourceDigest(record) },
                });
                evidenceIds.push(id);
              }
            }
            const payload = {
              schemaVersion: 1 as const,
              snapshotDigest: observation.contentDigest,
              policyDigest,
              observedAt: snapshot.observedAt,
              watermarks: effective.map((value) => value.mark),
              evidenceIds,
            };
            await tx.deliveryEvent.create({
              data: {
                id: eventId,
                ownerId,
                taskId,
                stepId,
                aggregateKey,
                aggregateVersion: (previous?.aggregateVersion ?? -1) + 1,
                type: "github_evidence_observed",
                policyVersion: policy.version,
                requestDigest: githubSourceDigest({ target, policy, contentDigest }),
                payload,
              },
            });
            // Writing the lock row also fences Serializable snapshots that began
            // before a concurrent publisher committed its separate source rows.
            // FOR UPDATE on an unchanged task alone can retain the older snapshot.
            await tx.deliveryTask.update({
              where: { ownerId_id: { ownerId, id: taskId } },
              data: { updatedAt: now },
            });
            const unsafe =
              policyChanged ||
              groupSetChanged ||
              effective.some((value) => value.status !== "passed");
            if (
              unsafe &&
              (step.state === "succeeded" ||
                oldEvidence.some((value) => value.status === "passed")) &&
              !current.pauseRequested
            ) {
              await tx.deliveryTask.update({
                where: { ownerId_id: { ownerId, id: taskId } },
                data: { pauseRequested: true, schedulingPaused: false, version: { increment: 1 } },
              });
              const noticeId = uid(`${eventId}/invalidate`);
              await tx.deliveryEvent.create({
                data: {
                  id: noticeId,
                  ownerId,
                  taskId,
                  stepId,
                  aggregateKey: `task/${taskId}`,
                  aggregateVersion: current.version + 1,
                  type: "github_evidence_invalidated",
                  policyVersion: policy.version,
                  requestDigest: githubSourceDigest({
                    eventId,
                    reason: "Required GitHub evidence changed or is unavailable",
                  }),
                  payload: {
                    causeEventId: eventId,
                    reason:
                      "Required GitHub evidence changed or is unavailable; accepted reports are historical.",
                  },
                },
              });
              await tx.deliveryOutbox.create({
                data: { ownerId, eventId: noticeId, channel: "push" },
              });
            }
            return {
              eventId,
              evidenceIds,
              replayed: false,
              eligibility: unsafe
                ? {
                    ...observation.eligibility,
                    eligible: false,
                    blockers: [...observation.eligibility.blockers, "persisted-source-not-passed"],
                  }
                : observation.eligibility,
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10000,
            timeout: 10000,
          },
        );
      } catch (error) {
        if (retry < 2 && isGitHubSerializationConflict(error)) {
          await new Promise((resolve) => setTimeout(resolve, 20 * (retry + 1)));
          continue;
        }
        throw error;
      }
    }
  }
}
