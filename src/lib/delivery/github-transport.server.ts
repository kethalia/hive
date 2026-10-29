import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { githubEvidencePolicySchema } from "./github-contracts";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import {
  GitHubEvidencePublisher,
  type ImmutableGitHubArtifactStore,
  isGitHubSerializationConflict,
} from "./github-persistence.server";
import {
  type GitHubChallengeRequest,
  type GitHubSourceEnvelope,
  githubChallengeRequestSchema,
  githubCollectionChallengeSchema,
  githubSourceEnvelopeSchema,
  githubTransportProofPayload,
} from "./github-transport-contracts";
import type { ManagerDependencies } from "./manager.server";
import {
  authenticateCheckoutHost,
  lockManagerCheckout,
  stableDeliveryUuid,
} from "./manager-binding.server";
import { resolveTaskSource } from "./source-resolver.server";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
const policyTarget = z
  .object({
    pullNumber: z.number().int().positive().max(2147483647),
    policy: githubEvidencePolicySchema,
  })
  .strict();
const storedChallenge = githubCollectionChallengeSchema
  .extend({
    policy: githubEvidencePolicySchema,
    checkoutBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export interface GitHubTransportDependencies extends Pick<ManagerDependencies, "reauthorize"> {
  /** Controller configuration only. No producer, PR or policy is accepted from
   * the model/collector request. The resolver must never trust repository files. */
  resolveTargetPolicy(scope: {
    ownerId: string;
    taskId: string;
    stepId: string;
    repositoryId: string;
    sourceSha: string;
    branch: string;
  }): Promise<unknown> | unknown;
}
const challengeKey = (stepId: string) => `github-source-challenge/${stepId}`;

/** Source-specific authority, independent of the manager tool. All production
 * factories are default-off until installed-helper/signer isolation is verified. */
export class GitHubSourceTransport {
  constructor(
    private readonly db: PrismaClient,
    private readonly dependencies: GitHubTransportDependencies,
    private readonly artifacts: ImmutableGitHubArtifactStore,
  ) {}
  private async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let count = 0; ; count++) {
      try {
        return await this.db.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10000,
          timeout: 10000,
        });
      } catch (error) {
        if (count >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
    }
  }
  private async scope(
    tx: Tx,
    input: GitHubChallengeRequest | GitHubSourceEnvelope,
    authenticated: { ownerId: string; hostPublicKeyPem: string },
  ) {
    const host = await lockManagerCheckout(tx, input, authenticated, { allowBlocked: true });
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM delivery_tasks WHERE owner_id=${authenticated.ownerId}::uuid AND id=${input.taskId}::uuid FOR UPDATE`;
    if (rows.length !== 1) throw new RegistrationRejected();
    const task = await tx.deliveryTask.findUniqueOrThrow({
      where: { ownerId_id: { ownerId: authenticated.ownerId, id: input.taskId } },
      include: { project: true, steps: { where: { id: input.stepId } } },
    });
    if (
      task.managerBindingId !== host.binding.id ||
      task.steps.length !== 1 ||
      task.projectId !== host.binding.projectId ||
      task.conversationId !== host.binding.conversationId
    )
      throw new RegistrationRejected();
    const source = await resolveTaskSource(
      tx,
      authenticated.ownerId,
      task.id,
      input.sourceContext,
      true,
    );
    const configured = policyTarget.parse(
      await this.dependencies.resolveTargetPolicy({
        ownerId: authenticated.ownerId,
        taskId: task.id,
        stepId: input.stepId,
        repositoryId: task.project.providerRepositoryId,
        sourceSha: task.sourceSha,
        branch: task.branch,
      }),
    );
    const target = {
      schemaVersion: 1 as const,
      providerRepositoryId: task.project.providerRepositoryId,
      providerAccountId: task.project.providerAccountId,
      fullName: task.project.fullName,
      pullNumber: source.task.currentSourceRevision?.pullNumber ?? configured.pullNumber,
      expectedHeadSha: task.sourceSha,
    };
    return {
      ...host,
      task,
      target,
      policy: configured.policy,
      policyDigest: githubSourceDigest(configured.policy),
    };
  }
  async requestChallenge(value: unknown) {
    const input = githubChallengeRequestSchema.parse(value);
    const authenticated = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      githubTransportProofPayload("challenge", value as Record<string, unknown>),
    );
    return this.transaction(async (tx) => {
      const scope = await this.scope(tx, input, authenticated);
      const requestDigest = githubSourceDigest({
        requestId: input.requestId,
        registrationId: input.registrationId,
        managerBindingId: scope.binding.id,
        taskId: input.taskId,
        stepId: input.stepId,
        target: scope.target,
        policyDigest: scope.policyDigest,
      });
      const previous = await tx.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId: authenticated.ownerId, id: input.requestId } },
      });
      const latest = await tx.deliveryEvent.findFirst({
        where: {
          ownerId: authenticated.ownerId,
          taskId: input.taskId,
          aggregateKey: challengeKey(input.stepId),
        },
        orderBy: { aggregateVersion: "desc" },
      });
      if (previous) {
        if (previous.type !== "github_source_challenge" || previous.requestDigest !== requestDigest)
          throw new DeliveryConflict("github_challenge_replay_conflict");
        const old = storedChallenge.parse(previous.payload);
        if (latest?.id !== previous.id) throw new DeliveryConflict("github_challenge_superseded");
        if (old.expiresAt <= scope.now.getTime())
          throw new DeliveryConflict("github_challenge_expired");
        const { policy: _policy, checkoutBindingDigest: _binding, ...publicChallenge } = old;
        return githubCollectionChallengeSchema.parse(publicChallenge);
      }
      if (latest && scope.now.getTime() - latest.createdAt.getTime() < 10000)
        throw new DeliveryConflict("github_refresh_too_frequent");
      const challenge = githubCollectionChallengeSchema.parse({
        schemaVersion: 1,
        action: "collect_github_evidence",
        id: input.requestId,
        nonce: randomBytes(32).toString("hex"),
        registrationId: input.registrationId,
        managerBindingId: scope.binding.id,
        target: scope.target,
        policyDigest: scope.policyDigest,
        expiresAt: scope.now.getTime() + 60000,
      });
      await tx.deliveryEvent.create({
        data: {
          id: challenge.id,
          ownerId: authenticated.ownerId,
          taskId: input.taskId,
          stepId: input.stepId,
          aggregateKey: challengeKey(input.stepId),
          aggregateVersion: (latest?.aggregateVersion ?? -1) + 1,
          type: "github_source_challenge",
          requestDigest,
          policyVersion: scope.policy.version,
          payload: {
            ...challenge,
            policy: scope.policy,
            checkoutBindingDigest: scope.binding.bindingDigest,
          },
        },
      });
      // Fence a Serializable waiter whose snapshot predates a challenge publish.
      await tx.deliveryTask.update({ where: { id: input.taskId }, data: { updatedAt: scope.now } });
      return challenge;
    });
  }
  async ingest(value: unknown) {
    const input = githubSourceEnvelopeSchema.parse(value);
    const authenticated = await authenticateCheckoutHost(
      this.db,
      this.dependencies.reauthorize,
      input,
      githubTransportProofPayload("snapshot", value as Record<string, unknown>),
    );
    const ownerId = authenticated.ownerId;
    const event = await this.db.deliveryEvent.findUnique({
      where: { ownerId_id: { ownerId, id: input.challengeId } },
    });
    if (
      !event ||
      event.type !== "github_source_challenge" ||
      event.taskId !== input.taskId ||
      event.stepId !== input.stepId
    )
      throw new RegistrationRejected();
    const challenge = storedChallenge.parse(event.payload);
    if (
      challenge.registrationId !== input.registrationId ||
      challenge.nonce !== input.nonce ||
      challenge.policyDigest !== input.policyDigest ||
      challenge.expiresAt <= Date.now()
    )
      throw new RegistrationRejected();
    const snapshotDigest = githubSourceDigest(input.snapshot);
    const receiptId = stableDeliveryUuid(`${input.challengeId}/github-source-consumed`);
    const receiptDigest = githubSourceDigest({
      challengeId: input.challengeId,
      nonce: input.nonce,
      snapshotDigest,
      policyDigest: input.policyDigest,
      registrationId: input.registrationId,
    });
    const authorize = async (tx: Tx, consume: boolean) => {
      const scope = await this.scope(tx, input, authenticated);
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_events WHERE owner_id=${ownerId}::uuid AND id=${input.challengeId}::uuid FOR UPDATE`;
      const latest = await tx.deliveryEvent.findFirst({
        where: { ownerId, taskId: input.taskId, aggregateKey: challengeKey(input.stepId) },
        orderBy: { aggregateVersion: "desc" },
      });
      if (
        rows.length !== 1 ||
        latest?.id !== input.challengeId ||
        scope.now.getTime() >= challenge.expiresAt ||
        scope.policyDigest !== challenge.policyDigest ||
        scope.binding.bindingDigest !== challenge.checkoutBindingDigest ||
        canonicalGitHubSource(scope.target) !== canonicalGitHubSource(challenge.target)
      )
        throw new RegistrationRejected();
      const consumed = await tx.deliveryEvent.findUnique({
        where: { ownerId_id: { ownerId, id: receiptId } },
      });
      if (consumed) {
        if (consumed.type !== "github_source_consumed" || consumed.requestDigest !== receiptDigest)
          throw new DeliveryConflict("github_challenge_already_consumed");
        return;
      }
      if (!consume) return;
      await tx.deliveryEvent.create({
        data: {
          id: receiptId,
          ownerId,
          taskId: input.taskId,
          stepId: input.stepId,
          aggregateKey: `github-source-receipt/${input.challengeId}`,
          aggregateVersion: 0,
          type: "github_source_consumed",
          requestDigest: receiptDigest,
          policyVersion: scope.policy.version,
          payload: {
            challengeId: input.challengeId,
            snapshotDigest,
            policyDigest: scope.policyDigest,
          },
        },
      });
    };
    // Known-revoked, superseded or changed-body requests must not cause object
    // writes. Recheck again when publishing to close revocation/upload races.
    await this.transaction((tx) => authorize(tx, false));
    const publisher = new GitHubEvidencePublisher(
      this.db,
      {
        collect: async (target) => {
          if (canonicalGitHubSource(target) !== canonicalGitHubSource(challenge.target))
            throw new RegistrationRejected();
          return input.snapshot;
        },
        authorizeTransaction: async (tx, binding) => {
          if (
            binding.ownerId !== ownerId ||
            binding.taskId !== input.taskId ||
            binding.stepId !== input.stepId ||
            binding.snapshotDigest !== snapshotDigest ||
            binding.policyDigest !== challenge.policyDigest
          )
            throw new RegistrationRejected();
          await authorize(tx, true);
        },
      },
      this.artifacts,
    );
    return publisher.publish(
      ownerId,
      input.taskId,
      input.stepId,
      challenge.target.pullNumber,
      challenge.policy,
    );
  }
}
