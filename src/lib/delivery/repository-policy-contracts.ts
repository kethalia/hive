import { createHash } from "node:crypto";
import { z } from "zod";
import { evidenceKindSchema, stepDefinitionSchema } from "./contracts";
import { githubEvidencePolicySchema } from "./github-contracts";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { sourcePublicationPolicySchema } from "./source-transport-contracts";
import { DeliveryConflict } from "./state";

const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const providerId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const label = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const semanticCriterion = label.refine((v) => !v.startsWith("repo:"));
export const repositoryPolicyTextDigest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Catalog content is deployment-owned. A model cannot select a contract by ID:
 * both owner intent bytes and the task outcome must match the approved meaning. */
export const repositoryAcceptanceContractSchema = z
  .object({
    id: label,
    intentTextDigest: digest,
    taskOutcomeDigest: digest,
    criteria: z
      .array(
        z
          .object({
            id: semanticCriterion,
            meaning: z.string().min(1).max(2000),
            kind: evidenceKindSchema,
            evaluatorGateKeys: z.array(digest).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const repositoryPolicyDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: sourcePublicationPolicySchema,
    evidenceGates: githubEvidencePolicySchema,
    acceptanceContracts: z.array(repositoryAcceptanceContractSchema).max(32),
  })
  .strict()
  .superRefine((v, ctx) => {
    const groups = repositoryGateDescriptors(v.evidenceGates);
    if (groups.some((g) => g.criteria.some((id) => !/^repo:[A-Za-z0-9_.:-]{1,95}$/.test(id))))
      ctx.addIssue({
        code: "custom",
        message: "Repository gates require reserved criterion identities",
      });
    const pairs = new Set<string>(),
      ids = new Set<string>();
    for (const contract of v.acceptanceContracts) {
      const pair = `${contract.intentTextDigest}/${contract.taskOutcomeDigest}`;
      if (pairs.has(pair) || ids.has(contract.id))
        ctx.addIssue({ code: "custom", message: "Ambiguous acceptance contract" });
      pairs.add(pair);
      ids.add(contract.id);
      const meanings = new Set<string>(),
        meaningById = new Map<string, string>();
      for (const criterion of contract.criteria) {
        const id = `${criterion.id}/${criterion.kind}`;
        if (
          meanings.has(id) ||
          (meaningById.has(criterion.id) && meaningById.get(criterion.id) !== criterion.meaning) ||
          new Set(criterion.evaluatorGateKeys).size !== criterion.evaluatorGateKeys.length
        )
          ctx.addIssue({ code: "custom", message: "Duplicate criterion coverage" });
        meanings.add(id);
        meaningById.set(criterion.id, criterion.meaning);
        if (
          criterion.evaluatorGateKeys.some(
            (key) => !groups.some((g) => g.key === key && g.kind === criterion.kind),
          )
        )
          ctx.addIssue({ code: "custom", message: "Unknown or incompatible acceptance evaluator" });
      }
    }
    if (new Set(groups.map((g) => g.key)).size !== groups.length)
      ctx.addIssue({ code: "custom", message: "Duplicate repository gate" });
    if (Buffer.byteLength(canonicalGitHubSource(v)) > 65536)
      ctx.addIssue({ code: "custom", message: "Repository policy byte limit" });
  });
export type RepositoryPolicyDefinition = z.infer<typeof repositoryPolicyDefinitionSchema>;
export const repositoryPolicyCatalogEntrySchema = z
  .object({
    ownerId: uuid,
    repositoryId: providerId,
    providerAccountId: providerId,
    fullName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
      .refine((v) => ![".", ".."].includes(v.split("/")[1])),
    policy: repositoryPolicyDefinitionSchema,
  })
  .strict();
export const repositoryPolicyCatalogSchema = z
  .array(repositoryPolicyCatalogEntrySchema)
  .max(32)
  .superRefine((entries, ctx) => {
    if (new Set(entries.map((e) => `${e.ownerId}/${e.repositoryId}`)).size !== entries.length)
      ctx.addIssue({ code: "custom", message: "Duplicate repository enrollment" });
    if (Buffer.byteLength(canonicalGitHubSource(entries)) > 262144)
      ctx.addIssue({ code: "custom", message: "Repository catalog byte limit" });
  });

/** Stable evaluator keys include full provider selector, never just a display
 * name/version label. Repository/account scope is additionally pinned by the
 * enrollment and full policy digest. */
export function repositoryGateDescriptors(policy: z.infer<typeof githubEvidencePolicySchema>) {
  return [
    ...policy.checks.map((v, index) => ({
      key: githubSourceDigest({
        type: "check",
        workflowId: v.workflowId,
        appId: v.appId,
        name: v.name,
        events: v.events,
      }),
      kind: "check" as const,
      criteria: v.criterionIds,
      index,
      group: "checks" as const,
    })),
    ...(policy.codexReview
      ? [
          {
            key: githubSourceDigest({
              type: "codex_review",
              userId: policy.codexReview.userId,
              appId: policy.codexReview.appId,
            }),
            kind: "review" as const,
            criteria: policy.codexReview.criterionIds,
            index: 0,
            group: "codexReview" as const,
          },
        ]
      : []),
    ...policy.formalReviewers.map((v, index) => ({
      key: githubSourceDigest({ type: "formal_review", userId: v.userId }),
      kind: "review" as const,
      criteria: v.criterionIds,
      index,
      group: "formalReviewers" as const,
    })),
  ];
}

/** Pure projection of a reviewed acceptance contract; unknown meanings remain
 * explicit pending requirements. It never relabels generic CI as arbitrary goal
 * evidence and never removes mandatory repository gates. */
export function compileRepositoryTaskPolicy(
  raw: unknown,
  intentTextDigest: string,
  outcome: string,
  rawSteps: unknown,
) {
  const policy = repositoryPolicyDefinitionSchema.parse(raw);
  digest.parse(intentTextDigest);
  z.string().min(1).max(4000).parse(outcome);
  // Only these immutable definition fields enter the policy projection. DB rows
  // also carry mutable scheduling fields, which are deliberately not authority.
  const steps = z
    .array(stepDefinitionSchema.strip())
    .min(1)
    .max(32)
    .parse(rawSteps)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(steps.map((step) => step.id)).size !== steps.length)
    throw new DeliveryConflict("repository_step_ambiguous");
  const outcomeDigest = repositoryPolicyTextDigest(outcome),
    contract = policy.acceptanceContracts.find(
      (v) => v.intentTextDigest === intentTextDigest && v.taskOutcomeDigest === outcomeDigest,
    );
  const compiled = structuredClone(policy.evidenceGates);
  const coverage: {
    stepId: string;
    criterionId: string;
    kind: string;
    meaningDigest: string;
    contractId: string;
    evaluatorGateKeys: string[];
    evaluationState: "awaiting_independent_producer";
  }[] = [];
  const pending: {
    stepId: string;
    criterionId: string;
    kind: string;
    reason: "acceptance_evaluator_unavailable" | "acceptance_evaluator_provenance_pending";
  }[] = [];
  for (const step of steps)
    for (const criterion of step.criterionIds)
      for (const kind of step.requiredEvidenceKinds) {
        if (criterion.startsWith("repo:"))
          throw new DeliveryConflict("repository_criterion_reserved");
        const link = contract?.criteria.find((v) => v.id === criterion && v.kind === kind);
        if (!link || !contract) {
          pending.push({
            stepId: step.id,
            criterionId: criterion,
            kind,
            reason: "acceptance_evaluator_unavailable",
          });
          continue;
        }
        coverage.push({
          stepId: step.id,
          criterionId: criterion,
          kind,
          meaningDigest: repositoryPolicyTextDigest(link.meaning),
          contractId: contract.id,
          evaluatorGateKeys: link.evaluatorGateKeys,
          evaluationState: "awaiting_independent_producer",
        });
        // Matching catalog selectors do not attest immutable evaluator code or
        // an intent-aware independent decision. Keep the reviewed linkage, but
        // never relabel ordinary repository CI as semantic goal verification.
        pending.push({
          stepId: step.id,
          criterionId: criterion,
          kind,
          reason: "acceptance_evaluator_provenance_pending",
        });
      }
  const result = {
    intentTextDigest,
    outcomeDigest,
    compiledEvidencePolicy: githubEvidencePolicySchema.parse(compiled),
    criterionCoverage: coverage,
    pendingRequirements: pending,
  };
  if (Buffer.byteLength(canonicalGitHubSource(result)) > 65536)
    throw new DeliveryConflict("repository_binding_limit");
  return { ...result, projectionDigest: githubSourceDigest(result) };
}
