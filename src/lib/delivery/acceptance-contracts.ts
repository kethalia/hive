import { z } from "zod";
import { acceptanceTerminalSchema } from "./acceptance-completion-contracts";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { managerCheckoutSchema } from "./manager-contracts";
import { sourceManifestSchema } from "./source-transport-contracts";

const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const label = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const text = (bytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= bytes);
const phase = z.enum(["implementation_preview", "activation_production"]);

/** Generic evaluator code/prompt/config identity is deployment-owned. Neither
 * a manager tool argument nor repository content may select this policy. */
export const acceptanceProducerSchema = z
  .object({
    schemaVersion: z.literal(1),
    codeDigest: digest,
    promptDigest: digest,
    schemaDigest: digest,
    permissionsDigest: digest,
    runtimeVersion: z.literal("0.165.0"),
    model: label,
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    maxDurationMs: z.number().int().min(1000).max(300000),
    maxInputBytes: z.number().int().min(32768).max(262144),
    maxOutputBytes: z.number().int().min(1024).max(65536),
  })
  .strict();
export type AcceptanceProducer = z.infer<typeof acceptanceProducerSchema>;

export const acceptanceRequirementSchema = z
  .object({
    id: z.string().regex(/^acceptance:[a-z0-9][a-z0-9_-]{0,63}$/),
    meaning: text(2000),
    phase,
    // Offsets are UTF-8 byte offsets into the immutable original intent.
    intentRanges: z
      .array(
        z
          .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
          .strict(),
      )
      .min(1)
      .max(16),
    verification: text(2000),
  })
  .strict();
export const acceptancePlanResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("plan"),
    intentDigest: digest,
    outcome: z.enum(["ready", "needs_clarification", "unsupported"]),
    requirements: z.array(acceptanceRequirementSchema).min(1).max(32),
    unresolved: z.array(text(2000)).max(16),
    rationale: text(4000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.requirements.map((requirement) => requirement.id)).size !==
      value.requirements.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate acceptance requirement" });
    if (value.outcome === "ready" && value.unresolved.length)
      ctx.addIssue({ code: "custom", message: "Unresolved acceptance plan" });
  });

export const acceptanceCitationSchema = z
  .object({
    artifactDigest: digest,
    // A sealed manifest entry, never a local filesystem path or remote URL.
    entryId: label,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
export const acceptanceReviewResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("review"),
    intentDigest: digest,
    planDigest: digest,
    sourceSha: sha,
    inputDigest: digest,
    outcome: z.enum(["pass", "fail", "insufficient"]),
    requirements: z
      .array(
        z
          .object({
            id: acceptanceRequirementSchema.shape.id,
            meaningDigest: digest,
            outcome: z.enum(["pass", "fail", "insufficient", "outside_step_scope"]),
            rationale: text(4000),
            citations: z.array(acceptanceCitationSchema).max(32),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    unresolved: z.array(text(2000)).max(16),
    rationale: text(4000),
  })
  .strict();
export type AcceptancePlanResult = z.infer<typeof acceptancePlanResultSchema>;
export type AcceptanceReviewResult = z.infer<typeof acceptanceReviewResultSchema>;

export const acceptanceJobScopeSchema = z
  .object({
    ownerId: id,
    projectId: id,
    preparationIntentId: id,
    repositoryPolicyVersionId: id,
    repositoryPolicyDigest: digest,
    intentDigest: digest,
    producerDigest: digest,
    kind: z.enum(["plan", "review"]),
    taskId: id.nullable(),
    stepId: id.nullable(),
    attemptId: id.nullable(),
    planDigest: digest.nullable(),
    sourceRevisionId: id.nullable(),
    sourceSha: sha.nullable(),
    sourceVersion: z.number().int().nonnegative().nullable(),
    sourceTreeSha: sha.nullable(),
    evidenceDigest: digest.nullable(),
    artifactDigest: digest.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fields = [
      value.taskId,
      value.stepId,
      value.attemptId,
      value.planDigest,
      value.sourceRevisionId,
      value.sourceSha,
      value.sourceVersion,
      value.sourceTreeSha,
      value.evidenceDigest,
      value.artifactDigest,
    ];
    if (
      value.kind === "plan"
        ? fields.some((field) => field !== null)
        : fields.some((field) => field === null)
    )
      ctx.addIssue({ code: "custom", message: "Acceptance job scope mismatch" });
  });
export type AcceptanceJobScope = z.infer<typeof acceptanceJobScopeSchema>;

export const acceptanceNativeReceiptSchema = z
  .object({
    threadId: label,
    turnId: label,
    runtimeVersion: z.literal("0.165.0"),
    requestedModel: label,
    effectiveModel: label,
    requestedEffort: acceptanceProducerSchema.shape.effort,
    effectiveEffort: acceptanceProducerSchema.shape.effort,
    inputDigest: digest,
    outputDigest: digest,
    configDigest: digest,
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().positive(),
    terminal: z.literal(true),
    controllerCreated: z.literal(true),
    unexpectedTools: z.literal(0),
    unexpectedChildren: z.literal(0),
  })
  .strict();

const baseRequest = z.object({
  schemaVersion: z.literal(1),
  requestId: id,
  registrationId: id,
  serverInstanceId: label,
  managerThreadId: label,
  checkoutBinding: managerCheckoutSchema,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export const acceptanceCandidateSchema = z
  .object({
    manifest: sourceManifestSchema,
    contents: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            text: z
              .string()
              .refine((value) => Buffer.byteLength(value) <= 131072, "Source text too large"),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 200000, "Acceptance candidate too large");
export const acceptanceRequestSchema = z.discriminatedUnion("action", [
  baseRequest.extend({ action: z.literal("claim_acceptance") }).strict(),
  baseRequest
    .extend({ action: z.literal("prepare_review"), candidate: acceptanceCandidateSchema })
    .strict(),
  baseRequest.extend({ action: z.literal("read_acceptance_plan") }).strict(),
  baseRequest.extend({ action: z.literal("repair_prepare") }).strict(),
  baseRequest
    .extend({ action: z.literal("complete_verified"), terminal: acceptanceTerminalSchema })
    .strict(),
  baseRequest.extend({ action: z.literal("repair_ready"), repairId: id }).strict(),
  baseRequest
    .extend({
      action: z.literal("start_acceptance"),
      jobId: id,
      leaseId: id,
      leaseGeneration: z.number().int().positive(),
      threadId: label,
    })
    .strict(),
  baseRequest
    .extend({
      action: z.literal("finish_acceptance"),
      jobId: id,
      leaseId: id,
      leaseGeneration: z.number().int().positive(),
      receipt: acceptanceNativeReceiptSchema,
      output: text(65536),
    })
    .strict(),
  baseRequest.extend({ action: z.literal("read_acceptance"), jobId: id }).strict(),
]);
export function acceptanceProofPayload(value: Record<string, unknown>) {
  const { proof: _proof, ...unsigned } = value;
  return `hive-delivery-acceptance-v1\nPOST\n/api/delivery/host/acceptance\n${canonicalGitHubSource(unsigned)}`;
}
export const acceptanceDigest = githubSourceDigest;

export function validatePlan(value: unknown, originalIntent: string) {
  const result = acceptancePlanResultSchema.parse(value);
  const bytes = Buffer.from(originalIntent, "utf8");
  // Bind exact bytes, including whitespace. JSON canonicalization is not a
  // substitute for the owner-intent digest recorded at enqueue.
  const actual = requireIntentDigest(originalIntent);
  if (result.intentDigest !== actual) throw new Error("acceptance_intent_mismatch");
  for (const requirement of result.requirements) {
    for (const range of requirement.intentRanges) {
      if (
        range.start >= range.end ||
        range.end > bytes.length ||
        Buffer.from(bytes.subarray(range.start, range.end).toString("utf8"), "utf8").length !==
          range.end - range.start
      )
        throw new Error("acceptance_intent_range_invalid");
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(range.start, range.end));
      } catch {
        throw new Error("acceptance_intent_range_invalid");
      }
    }
  }
  return result;
}

// Kept separate from canonical-JSON digests to match D08's immutable text pin.
import { createHash } from "node:crypto";
export const requireIntentDigest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

export function validateReview(
  value: unknown,
  expected: {
    intentDigest: string;
    plan: AcceptancePlanResult;
    planDigest: string;
    sourceSha: string;
    inputDigest: string;
    criterionIds: readonly string[];
    phase: "implementation_preview" | "activation_production";
    artifacts: ReadonlyMap<string, { digest: string; bytes: number }>;
  },
) {
  const result = acceptanceReviewResultSchema.parse(value);
  if (
    result.intentDigest !== expected.intentDigest ||
    result.planDigest !== expected.planDigest ||
    result.sourceSha !== expected.sourceSha ||
    result.inputDigest !== expected.inputDigest
  )
    throw new Error("acceptance_review_scope_mismatch");
  if (
    result.requirements.length !== expected.plan.requirements.length ||
    new Set(result.requirements.map((requirement) => requirement.id)).size !==
      result.requirements.length
  )
    throw new Error("acceptance_review_coverage_missing");
  const requested = new Set(expected.criterionIds);
  if (
    !requested.size ||
    [...requested].some((id) => !expected.plan.requirements.some((r) => r.id === id))
  )
    throw new Error("acceptance_requirement_unknown");
  for (const requirement of expected.plan.requirements) {
    const observation = result.requirements.find((r) => r.id === requirement.id);
    if (!observation || observation.meaningDigest !== requireIntentDigest(requirement.meaning))
      throw new Error("acceptance_requirement_meaning_mismatch");
    if (observation.outcome === "outside_step_scope" && requested.has(requirement.id))
      throw new Error("acceptance_review_coverage_missing");
    if (
      observation.outcome === "pass" &&
      (requirement.phase !== expected.phase || !observation.citations.length)
    )
      throw new Error("acceptance_review_evidence_missing");
    for (const citation of observation.citations) {
      const artifact = expected.artifacts.get(citation.entryId);
      if (
        !artifact ||
        artifact.digest !== citation.artifactDigest ||
        citation.start >= citation.end ||
        citation.end > artifact.bytes
      )
        throw new Error("acceptance_citation_invalid");
    }
  }
  if (
    result.outcome === "pass" &&
    (result.unresolved.length ||
      result.requirements.some((r) => requested.has(r.id) && r.outcome !== "pass"))
  )
    throw new Error("acceptance_review_not_satisfied");
  return result;
}
