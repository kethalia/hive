import { randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@hive/auth";
import type { DeliveryAcceptanceJob, Prisma, ProjectTaskIntent } from "@hive/db";
import { z } from "zod";
import type { TaskIntentPayload } from "@/lib/projects/task-intents.server";
import {
  type AcceptanceJobScope,
  type AcceptancePlanResult,
  type AcceptanceProducer,
  acceptanceDigest,
  acceptanceJobScopeSchema,
  acceptanceNativeReceiptSchema,
  acceptancePlanResultSchema,
  acceptanceProducerSchema,
  acceptanceReviewResultSchema,
  requireIntentDigest,
  validatePlan,
  validateReview,
} from "./acceptance-contracts";
import { acceptanceEvidenceProducer } from "./acceptance-policy.server";
import {
  ACCEPTANCE_PROMPT_DIGEST,
  ACCEPTANCE_SCHEMA_DIGEST,
  acceptanceOutputSchemas,
  acceptancePrompts,
} from "./acceptance-prompts";
import { canonicalGitHubSource } from "./github-evidence.server";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(canonicalGitHubSource(value)) as Prisma.InputJsonValue;
const same = (a: unknown, b: unknown) => canonicalGitHubSource(a) === canonicalGitHubSource(b);
function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new DeliveryConflict(reason);
}
export interface AcceptanceAuthority {
  ownerId: string;
  projectId: string;
  preparationIntentId: string;
  registrationId: string;
  serverInstanceId: string;
  managerThreadId: string;
  // Derived by the signed service from locked guardian rows, not host JSON.
  producer: Record<string, unknown>;
}
export interface AcceptanceMaterial {
  payload: Record<string, unknown>;
  evidencePolicyVersion?: string;
  review?: Omit<Parameters<typeof validateReview>[1], "inputDigest">;
}
export type AcceptanceMaterialLoader = (
  tx: Tx,
  scope: AcceptanceJobScope,
  material: unknown,
) => Promise<AcceptanceMaterial>;

/** Internal transactional persistence. Public callers must first lock and
 * authorize current owner/registration/guardian/intent at the service boundary.
 * These methods never grant execution, publication or cleanup authority. */
export class AcceptanceStore {
  readonly producer: AcceptanceProducer;
  readonly producerDigest: string;
  constructor(
    private readonly options: {
      enabled: boolean;
      encryptionKey: string;
      producer: AcceptanceProducer;
      materializeReview: AcceptanceMaterialLoader;
    },
  ) {
    this.producer = acceptanceProducerSchema.parse(options.producer);
    this.producerDigest = acceptanceDigest(this.producer);
    requireValue(
      this.producer.promptDigest === ACCEPTANCE_PROMPT_DIGEST &&
        this.producer.schemaDigest === ACCEPTANCE_SCHEMA_DIGEST,
      "acceptance_protocol_mismatch",
    );
  }
  private enabled() {
    requireValue(this.options.enabled, "acceptance_disabled");
  }
  async captureIntent(tx: Tx, input: TaskIntentPayload, row: ProjectTaskIntent) {
    this.enabled();
    const intentDigest = requireIntentDigest(input.hostRequest.text);
    requireValue(
      row.repositoryPolicyVersionId &&
        row.repositoryPolicyDigest &&
        row.intentTextDigest === intentDigest &&
        row.ownerId === input.ownerId &&
        row.projectId === input.projectId &&
        row.id === input.taskId &&
        row.requestDigest === input.requestDigest,
      "acceptance_intent_binding",
    );
    const sealed = {
      purpose: "hive-independent-acceptance-v1",
      ownerId: row.ownerId,
      projectId: row.projectId,
      intentId: row.id,
      requestDigest: row.requestDigest,
      policyVersionId: row.repositoryPolicyVersionId,
      policyDigest: row.repositoryPolicyDigest,
      intentDigest,
      text: input.hostRequest.text,
    };
    const encrypted = encrypt(canonicalGitHubSource(sealed), this.options.encryptionKey);
    await tx.deliveryAcceptanceIntent.createMany({
      data: {
        ownerId: row.ownerId,
        projectId: row.projectId,
        intentId: row.id,
        policyVersionId: row.repositoryPolicyVersionId,
        policyDigest: row.repositoryPolicyDigest,
        intentDigest,
        requestDigest: row.requestDigest,
        ciphertext: Uint8Array.from(encrypted.ciphertext),
        iv: Uint8Array.from(encrypted.iv),
        authTag: Uint8Array.from(encrypted.authTag),
      },
      skipDuplicates: true,
    });
    const captured = await this.originalIntent(tx, row.ownerId, row.id);
    requireValue(same(captured.sealed, sealed), "acceptance_intent_replay_mismatch");
    await this.enqueue(tx, {
      ownerId: row.ownerId,
      projectId: row.projectId,
      preparationIntentId: row.id,
      repositoryPolicyVersionId: row.repositoryPolicyVersionId,
      repositoryPolicyDigest: row.repositoryPolicyDigest,
      intentDigest,
      producerDigest: this.producerDigest,
      kind: "plan",
      taskId: null,
      stepId: null,
      attemptId: null,
      planDigest: null,
      sourceRevisionId: null,
      sourceSha: null,
      sourceVersion: null,
      sourceTreeSha: null,
      evidenceDigest: null,
      artifactDigest: null,
    });
  }
  async originalIntent(tx: Tx, ownerId: string, intentId: string) {
    const row = await tx.deliveryAcceptanceIntent.findUnique({
      where: { ownerId_intentId: { ownerId, intentId } },
    });
    requireValue(row, "acceptance_original_intent_unavailable");
    const sealed = z
      .object({
        purpose: z.literal("hive-independent-acceptance-v1"),
        ownerId: z.string().uuid(),
        projectId: z.string().uuid(),
        intentId: z.string().uuid(),
        requestDigest: z.string(),
        policyVersionId: z.string().uuid(),
        policyDigest: z.string(),
        intentDigest: z.string(),
        text: z.string().min(1).max(32768),
      })
      .strict()
      .parse(
        JSON.parse(
          decrypt(
            {
              ciphertext: Buffer.from(row.ciphertext),
              iv: Buffer.from(row.iv),
              authTag: Buffer.from(row.authTag),
            },
            this.options.encryptionKey,
          ),
        ),
      );
    requireValue(
      sealed.ownerId === row.ownerId &&
        sealed.projectId === row.projectId &&
        sealed.intentId === row.intentId &&
        sealed.policyVersionId === row.policyVersionId &&
        sealed.policyDigest === row.policyDigest &&
        sealed.intentDigest === row.intentDigest &&
        sealed.requestDigest === row.requestDigest &&
        requireIntentDigest(sealed.text) === row.intentDigest &&
        Buffer.byteLength(sealed.text) <= 32768,
      "acceptance_original_intent_mismatch",
    );
    return { row, sealed };
  }
  async enqueue(tx: Tx, raw: AcceptanceJobScope, material: Record<string, unknown> | null = null) {
    this.enabled();
    const scope = acceptanceJobScopeSchema.parse(raw);
    requireValue(scope.producerDigest === this.producerDigest, "acceptance_producer_mismatch");
    const original = await this.originalIntent(tx, scope.ownerId, scope.preparationIntentId);
    requireValue(
      original.row.projectId === scope.projectId &&
        original.row.policyVersionId === scope.repositoryPolicyVersionId &&
        original.row.policyDigest === scope.repositoryPolicyDigest &&
        original.row.intentDigest === scope.intentDigest,
      "acceptance_job_intent_mismatch",
    );
    const requestDigest = acceptanceDigest({ scope, producer: this.producer });
    await tx.deliveryAcceptanceJob.createMany({
      data: {
        id: randomUUID(),
        ownerId: scope.ownerId,
        projectId: scope.projectId,
        intentId: scope.preparationIntentId,
        taskId: scope.taskId,
        kind: scope.kind,
        material: material === null ? undefined : json(material),
        scope: json(scope),
        requestDigest,
        producer: json(this.producer),
        producerDigest: this.producerDigest,
      },
      skipDuplicates: true,
    });
    const row = await tx.deliveryAcceptanceJob.findUniqueOrThrow({
      where: {
        ownerId_intentId_requestDigest: {
          ownerId: scope.ownerId,
          intentId: scope.preparationIntentId,
          requestDigest,
        },
      },
    });
    requireValue(
      same(row.scope, scope) && same(row.producer, this.producer) && same(row.material, material),
      "acceptance_job_replay_mismatch",
    );
    return row;
  }
  private async material(tx: Tx, job: DeliveryAcceptanceJob) {
    const scope = acceptanceJobScopeSchema.parse(job.scope);
    requireValue(
      job.ownerId === scope.ownerId &&
        job.intentId === scope.preparationIntentId &&
        job.projectId === scope.projectId &&
        job.producerDigest === this.producerDigest &&
        same(job.producer, this.producer),
      "acceptance_job_scope_mismatch",
    );
    const original = await this.originalIntent(tx, scope.ownerId, scope.preparationIntentId);
    requireValue(
      original.row.intentDigest === scope.intentDigest &&
        original.row.policyDigest === scope.repositoryPolicyDigest,
      "acceptance_job_intent_mismatch",
    );
    const material: AcceptanceMaterial =
      scope.kind === "plan"
        ? {
            payload: {
              schemaVersion: 1,
              kind: "plan",
              intentDigest: scope.intentDigest,
              originalIntent: original.sealed.text,
              intentRange: { start: 0, end: Buffer.byteLength(original.sealed.text) },
            },
          }
        : await this.options.materializeReview(tx, scope, job.material);
    const payload = { ...material.payload, scope, originalIntent: original.sealed.text };
    requireValue(
      Buffer.byteLength(canonicalGitHubSource(payload)) <= this.producer.maxInputBytes,
      "acceptance_input_limit",
    );
    if (scope.kind === "review")
      requireValue(
        material.review &&
          material.review.intentDigest === scope.intentDigest &&
          material.review.planDigest === scope.planDigest &&
          material.review.sourceSha === scope.sourceSha,
        "acceptance_review_material_mismatch",
      );
    return {
      scope,
      payload,
      review: material.review,
      evidencePolicyVersion: material.evidencePolicyVersion,
      inputDigest: acceptanceDigest(payload),
      original: original.sealed.text,
    };
  }
  private async locked(tx: Tx, authority: AcceptanceAuthority, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM delivery_acceptance_jobs
      WHERE owner_id=${authority.ownerId}::uuid AND id=${id}::uuid FOR UPDATE`;
    requireValue(rows.length === 1, "acceptance_job_unavailable");
    const job = await tx.deliveryAcceptanceJob.findUniqueOrThrow({ where: { id } });
    requireValue(
      job.ownerId === authority.ownerId &&
        job.projectId === authority.projectId &&
        job.intentId === authority.preparationIntentId &&
        job.producerDigest === this.producerDigest,
      "acceptance_job_scope_mismatch",
    );
    return job;
  }
  private authorityMatches(job: DeliveryAcceptanceJob, authority: AcceptanceAuthority) {
    requireValue(
      job.registrationId === authority.registrationId &&
        job.serverInstanceId === authority.serverInstanceId &&
        job.managerThreadId === authority.managerThreadId &&
        same(job.authority, authority.producer),
      "acceptance_job_authority_changed",
    );
  }
  async claim(tx: Tx, authority: AcceptanceAuthority) {
    this.enabled();
    const lockedIntent = await tx.$queryRaw<
      { intent_id: string }[]
    >`SELECT intent_id FROM delivery_acceptance_intents
      WHERE owner_id=${authority.ownerId}::uuid AND intent_id=${authority.preparationIntentId}::uuid FOR UPDATE`;
    requireValue(lockedIntent.length === 1, "acceptance_original_intent_unavailable");
    // A started but uncertain inference is never automatically replaced. The
    // durable host journal may reconcile that same exact thread/turn only.
    const currentTime = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0]
      .now;
    const inFlight = await tx.deliveryAcceptanceJob.findFirst({
      where: {
        ownerId: authority.ownerId,
        intentId: authority.preparationIntentId,
        OR: [{ phase: "started" }, { phase: "leased", leaseUntil: { gt: currentTime } }],
      },
    });
    if (inFlight) return { phase: "reconcile" as const, jobId: inFlight.id };
    const candidates = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM delivery_acceptance_jobs
      WHERE owner_id=${authority.ownerId}::uuid AND intent_id=${authority.preparationIntentId}::uuid
      AND producer_digest=${this.producerDigest} AND (phase='queued' OR (phase='leased' AND lease_until<=clock_timestamp()))
      ORDER BY created_at,id LIMIT 16 FOR UPDATE SKIP LOCKED`;
    let job: DeliveryAcceptanceJob | undefined;
    let material: Awaited<ReturnType<AcceptanceStore["material"]>> | undefined;
    for (const candidate of candidates) {
      const row = await this.locked(tx, authority, candidate.id);
      try {
        material = await this.material(tx, row);
        job = row;
        break;
      } catch (error) {
        if (
          !(error instanceof DeliveryConflict) ||
          error.code !== "acceptance_material_unavailable" ||
          row.kind !== "review"
        )
          throw error;
        await tx.deliveryAcceptanceJob.update({
          where: { id: row.id },
          data: { phase: "held", heldReason: "acceptance_material_changed" },
        });
      }
    }
    if (!job || !material) return { phase: "idle" as const };
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    const leaseId = randomUUID(),
      leaseUntil = new Date(now.getTime() + this.producer.maxDurationMs);
    const leased = await tx.deliveryAcceptanceJob.update({
      where: { id: job.id },
      data: {
        phase: "leased",
        leaseId,
        leaseGeneration: job.leaseGeneration + 1,
        leaseUntil,
        registrationId: authority.registrationId,
        serverInstanceId: authority.serverInstanceId,
        managerThreadId: authority.managerThreadId,
        authority: json(authority.producer),
        inputDigest: material.inputDigest,
        updatedAt: now,
      },
    });
    return {
      phase: "leased" as const,
      jobId: job.id,
      leaseId,
      leaseGeneration: leased.leaseGeneration,
      expiresAt: leaseUntil.getTime(),
      producer: this.producer,
      inputDigest: material.inputDigest,
      payload: material.payload,
      kind: job.kind,
      instructions: acceptancePrompts[material.scope.kind],
      outputSchema: acceptanceOutputSchemas[material.scope.kind],
      protocol: { prompts: acceptancePrompts, schemas: acceptanceOutputSchemas },
    };
  }
  async start(
    tx: Tx,
    authority: AcceptanceAuthority,
    input: { jobId: string; leaseId: string; leaseGeneration: number; threadId: string },
  ) {
    this.enabled();
    const job = await this.locked(tx, authority, input.jobId);
    this.authorityMatches(job, authority);
    requireValue(
      job.leaseId === input.leaseId &&
        job.leaseGeneration === input.leaseGeneration &&
        input.threadId !== authority.managerThreadId,
      "acceptance_start_binding",
    );
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    requireValue(job.leaseUntil && job.leaseUntil > now, "acceptance_lease_expired");
    const material = await this.material(tx, job);
    requireValue(material.inputDigest === job.inputDigest, "acceptance_input_changed");
    if (job.phase === "started") {
      requireValue(job.evaluatorThreadId === input.threadId, "acceptance_thread_mismatch");
      return { phase: "started" as const, jobId: job.id, threadId: input.threadId, replay: true };
    }
    requireValue(job.phase === "leased", "acceptance_start_held");
    await tx.deliveryAcceptanceJob.update({
      where: { id: job.id },
      data: {
        phase: "started",
        evaluatorThreadId: input.threadId,
        updatedAt: now,
      },
    });
    return { phase: "started" as const, jobId: job.id, threadId: input.threadId, replay: false };
  }
  async finish(
    tx: Tx,
    authority: AcceptanceAuthority,
    input: {
      jobId: string;
      leaseId: string;
      leaseGeneration: number;
      receipt: z.infer<typeof acceptanceNativeReceiptSchema>;
      output: string;
    },
  ) {
    this.enabled();
    const job = await this.locked(tx, authority, input.jobId);
    this.authorityMatches(job, authority);
    const receipt = acceptanceNativeReceiptSchema.parse(input.receipt);
    requireValue(
      job.leaseId === input.leaseId &&
        job.leaseGeneration === input.leaseGeneration &&
        job.evaluatorThreadId === receipt.threadId &&
        receipt.threadId !== authority.managerThreadId &&
        receipt.requestedModel === this.producer.model &&
        receipt.effectiveModel === this.producer.model &&
        receipt.requestedEffort === this.producer.effort &&
        receipt.effectiveEffort === this.producer.effort &&
        receipt.inputDigest === job.inputDigest &&
        receipt.configDigest === this.producer.permissionsDigest &&
        receipt.completedAt >= receipt.startedAt &&
        receipt.completedAt - receipt.startedAt <= this.producer.maxDurationMs &&
        receipt.outputDigest === requireIntentDigest(input.output) &&
        Buffer.byteLength(input.output) <= this.producer.maxOutputBytes,
      "acceptance_result_provenance",
    );
    if (job.phase === "completed") {
      const result =
        job.kind === "plan"
          ? acceptancePlanResultSchema.parse(JSON.parse(input.output))
          : acceptanceReviewResultSchema.parse(JSON.parse(input.output));
      requireValue(
        job.resultDigest === acceptanceDigest(result) && same(job.receipt, receipt),
        "acceptance_result_replay_mismatch",
      );
      return {
        phase: "completed" as const,
        jobId: job.id,
        resultDigest: job.resultDigest,
        outcome: result.outcome,
        replay: true,
        historical: true,
      };
    }
    if (job.phase === "held" && job.heldReason === "acceptance_material_changed")
      return { phase: "held" as const, jobId: job.id, reason: job.heldReason };
    let material: Awaited<ReturnType<AcceptanceStore["material"]>>;
    try {
      material = await this.material(tx, job);
    } catch (error) {
      if (
        !(error instanceof DeliveryConflict) ||
        error.code !== "acceptance_material_unavailable" ||
        job.kind !== "review" ||
        job.phase !== "started"
      )
        throw error;
      await tx.deliveryAcceptanceJob.update({
        where: { id: job.id },
        data: { phase: "held", heldReason: "acceptance_material_changed" },
      });
      return { phase: "held" as const, jobId: job.id, reason: "acceptance_material_changed" };
    }
    requireValue(material.inputDigest === job.inputDigest, "acceptance_input_changed");
    const raw = JSON.parse(input.output);
    if (job.kind === "review") requireValue(material.review, "acceptance_review_material_mismatch");
    const result =
      job.kind === "plan"
        ? validatePlan(raw, material.original)
        : validateReview(raw, {
            ...(material.review as NonNullable<typeof material.review>),
            inputDigest: material.inputDigest,
          });
    const resultDigest = acceptanceDigest(result);
    const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    requireValue(
      job.phase === "started" &&
        job.leaseUntil &&
        job.leaseUntil > now &&
        receipt.completedAt <= now.getTime() + 5000,
      "acceptance_result_expired",
    );
    await tx.deliveryAcceptanceJob.update({
      where: { id: job.id },
      data: {
        phase: "completed",
        evaluatorTurnId: receipt.turnId,
        result: json(result),
        resultDigest,
        receipt: json(receipt),
        completedAt: now,
        updatedAt: now,
      },
    });
    if (job.kind === "review") {
      requireValue(
        material.evidencePolicyVersion &&
          material.review &&
          material.scope.stepId &&
          material.scope.sourceSha,
        "acceptance_evidence_scope",
      );
      requireValue(
        material.review.phase === "implementation_preview",
        "acceptance_production_observation_unavailable",
      );
      const record = {
        id: job.id,
        ownerId: job.ownerId,
        stepId: material.scope.stepId,
        producer: acceptanceEvidenceProducer(this.producerDigest),
        remoteId: job.id,
        policyVersion: material.evidencePolicyVersion,
        kind: "review",
        status:
          result.outcome === "pass" ? "passed" : result.outcome === "fail" ? "failed" : "unknown",
        verificationMode: "integration",
        environment: "codex-independent-readonly",
        sourceSha: material.scope.sourceSha,
        criterionIds: [...material.review.criterionIds],
        objectKey: `database/acceptance/${job.ownerId}/${job.id}`,
        contentDigest: resultDigest,
        observedAt: now,
      };
      await tx.deliveryEvidence.create({
        data: { ...record, requestDigest: acceptanceDigest(record) },
      });
    }
    if (job.kind === "plan")
      await tx.deliveryAcceptancePlan.create({
        data: {
          id: randomUUID(),
          ownerId: job.ownerId,
          projectId: job.projectId,
          intentId: job.intentId,
          sourceJobId: job.id,
          producerDigest: job.producerDigest,
          intentDigest: material.scope.intentDigest,
          planDigest: resultDigest,
          content: json(result as AcceptancePlanResult),
        },
      });
    return {
      phase: "completed" as const,
      jobId: job.id,
      resultDigest,
      outcome: result.outcome,
      replay: false,
    };
  }
  async read(tx: Tx, authority: AcceptanceAuthority, jobId: string) {
    this.enabled();
    const job = await this.locked(tx, authority, jobId);
    if (job.phase !== "queued") this.authorityMatches(job, authority);
    return {
      jobId: job.id,
      phase: job.phase,
      leaseGeneration: job.leaseGeneration,
      threadId: job.evaluatorThreadId,
      turnId: job.evaluatorTurnId,
      resultDigest: job.resultDigest,
      result: job.result,
      executionAuthorized: false,
      publicationAuthorized: false,
      cleanupAuthorized: false,
    };
  }
}
