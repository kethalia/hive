import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { isGitHubSerializationConflict } from "./github-persistence.server";
import {
  compileRepositoryTaskPolicy,
  repositoryPolicyCatalogSchema,
  repositoryPolicyDefinitionSchema,
  repositoryPolicyTextDigest,
} from "./repository-policy-contracts";
import { DeliveryConflict } from "./state";

type Tx = Prisma.TransactionClient;
const uuid = z.string().uuid();
function reject(reason: string): never {
  throw new DeliveryConflict(reason);
}
const verifiedRepositorySchema = z
  .object({
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    providerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    fullName: z.string().min(3).max(140),
    defaultBranch: z.string().min(1).max(151),
    defaultRevision: z.string().regex(/^[a-f0-9]{40}$/),
    archived: z.literal(false),
    permissions: z.object({ pull: z.literal(true), push: z.literal(true) }).strict(),
  })
  .strict();
type VerifiedRepository = z.infer<typeof verifiedRepositorySchema>;
type PolicyRow = {
  id: string;
  ownerId: string;
  projectId: string;
  repositoryId: string;
  providerAccountId: string;
  fullName: string;
  activeVersionId: string | null;
  generation: number;
  revokedAt: Date | null;
};
type VersionRow = {
  id: string;
  ownerId: string;
  projectId: string;
  policyId: string;
  version: number;
  policyDigest: string;
  catalogDigest: string;
  sourcePolicy: unknown;
  evidenceGates: unknown;
  acceptanceContracts: unknown;
  verifiedIdentity: unknown;
  verifiedIdentityDigest: string;
  revokedAt: Date | null;
};
type BindingRow = {
  ownerId: string;
  taskId: string;
  projectId: string;
  intentId: string;
  policyVersionId: string;
  policyDigest: string;
  bindingDigest: string;
  intentTextDigest: string;
  outcomeDigest: string;
  sourceBase: string;
  compiledEvidencePolicy: unknown;
  criterionCoverage: unknown;
  pendingRequirements: unknown;
};
const policyColumns = Prisma.sql`id,owner_id AS "ownerId",project_id AS "projectId",repository_id AS "repositoryId",provider_account_id AS "providerAccountId",full_name AS "fullName",active_version_id AS "activeVersionId",generation,revoked_at AS "revokedAt"`;
const versionColumns = Prisma.sql`id,owner_id AS "ownerId",project_id AS "projectId",policy_id AS "policyId",version,policy_digest AS "policyDigest",catalog_digest AS "catalogDigest",source_policy AS "sourcePolicy",evidence_gates AS "evidenceGates",acceptance_contracts AS "acceptanceContracts",verified_identity AS "verifiedIdentity",verified_identity_digest AS "verifiedIdentityDigest",revoked_at AS "revokedAt"`;
const bindingColumns = Prisma.sql`owner_id AS "ownerId",task_id AS "taskId",project_id AS "projectId",intent_id AS "intentId",policy_version_id AS "policyVersionId",policy_digest AS "policyDigest",binding_digest AS "bindingDigest",intent_text_digest AS "intentTextDigest",outcome_digest AS "outcomeDigest",source_base AS "sourceBase",compiled_evidence_policy AS "compiledEvidencePolicy",criterion_coverage AS "criterionCoverage",pending_requirements AS "pendingRequirements"`;
const definition = (v: VersionRow) =>
  repositoryPolicyDefinitionSchema.parse({
    schemaVersion: 1,
    source: v.sourcePolicy,
    evidenceGates: v.evidenceGates,
    acceptanceContracts: v.acceptanceContracts,
  });
const same = (a: unknown, b: unknown) => canonicalGitHubSource(a) === canonicalGitHubSource(b);

/** No HTTP policy mutation API. The catalog and verifier are trusted controller
 * dependencies; caller/model task metadata never supplies policy content. */
export class RepositoryPolicyStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: {
      enabled: boolean;
      readCatalog: () => unknown;
      verifyRepository: (scope: {
        ownerId: string;
        projectId: string;
        repositoryId: string;
        providerAccountId: string;
      }) => Promise<unknown>;
    },
  ) {}
  get enabled() {
    return this.options.enabled;
  }
  private enabledOnly() {
    if (!this.enabled) reject("repository_policy_disabled");
  }
  private catalog() {
    return repositoryPolicyCatalogSchema.parse(this.options.readCatalog());
  }
  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry++)
      try {
        return await this.db.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5000,
          timeout: 10000,
        });
      } catch (error) {
        if (retry >= 2 || !isGitHubSerializationConflict(error)) throw error;
      }
  }
  async enroll(ownerId: string, projectId: string) {
    this.enabledOnly();
    uuid.parse(ownerId);
    uuid.parse(projectId);
    const project = await this.db.deliveryProject.findUnique({
      where: { ownerId_id: { ownerId, id: projectId } },
    });
    if (!project || project.provider !== "github") reject("repository_policy_project_denied");
    const catalog = this.catalog(),
      selected = catalog.find(
        (v) => v.ownerId === ownerId && v.repositoryId === project.providerRepositoryId,
      );
    if (
      !selected ||
      selected.providerAccountId !== project.providerAccountId ||
      selected.fullName !== project.fullName
    )
      reject("repository_policy_not_enrolled");
    const expected = selected,
      catalogDigest = githubSourceDigest(catalog),
      policyDigest = githubSourceDigest(expected.policy);
    const verified = verifiedRepositorySchema.parse(
      await this.options.verifyRepository({
        ownerId,
        projectId,
        repositoryId: project.providerRepositoryId,
        providerAccountId: project.providerAccountId,
      }),
    );
    if (
      verified.repositoryId !== project.providerRepositoryId ||
      verified.providerAccountId !== project.providerAccountId ||
      verified.fullName !== project.fullName
    )
      reject("repository_policy_identity_changed");
    const verifiedIdentity = { schemaVersion: 1, ...verified, observedAt: Date.now() },
      identityDigest = githubSourceDigest(verifiedIdentity);
    return this.transaction(async (tx) => {
      if (catalogDigest !== githubSourceDigest(this.catalog()))
        reject("repository_policy_catalog_changed");
      await tx.$queryRaw`SELECT id FROM delivery_projects WHERE owner_id=${ownerId}::uuid AND id=${projectId}::uuid FOR UPDATE`;
      const current = await tx.deliveryProject.findUniqueOrThrow({
        where: { ownerId_id: { ownerId, id: projectId } },
      });
      if (
        current.provider !== "github" ||
        current.providerRepositoryId !== verified.repositoryId ||
        current.providerAccountId !== verified.providerAccountId ||
        current.fullName !== verified.fullName
      )
        reject("repository_policy_identity_changed");
      await tx.$executeRaw`INSERT INTO delivery_repository_policies(id,owner_id,project_id,provider,repository_id,provider_account_id,full_name) VALUES(${randomUUID()}::uuid,${ownerId}::uuid,${projectId}::uuid,'github',${verified.repositoryId},${verified.providerAccountId},${verified.fullName}) ON CONFLICT(owner_id,project_id) DO NOTHING`;
      const p = (
        await tx.$queryRaw<
          PolicyRow[]
        >`SELECT ${policyColumns} FROM delivery_repository_policies WHERE owner_id=${ownerId}::uuid AND project_id=${projectId}::uuid FOR UPDATE`
      )[0];
      if (
        !p ||
        p.revokedAt ||
        p.repositoryId !== verified.repositoryId ||
        p.providerAccountId !== verified.providerAccountId ||
        p.fullName !== verified.fullName
      )
        reject("repository_policy_enrollment_revoked");
      const old = p.activeVersionId
        ? (
            await tx.$queryRaw<
              VersionRow[]
            >`SELECT ${versionColumns} FROM delivery_repository_policy_versions WHERE owner_id=${ownerId}::uuid AND id=${p.activeVersionId}::uuid FOR UPDATE`
          )[0]
        : undefined;
      // A revoked active version cannot be resurrected by the next ordinary
      // task start reading the unchanged catalog. A new approved version must
      // be an explicit catalog content change.
      if (old?.revokedAt && old.policyDigest === policyDigest) reject("repository_policy_revoked");
      if (old && !old.revokedAt && old.policyDigest === policyDigest) {
        if (githubSourceDigest(definition(old)) !== policyDigest)
          reject("repository_policy_corrupt");
        return { versionId: old.id, policyDigest, policy: definition(old), verified };
      }
      const next = (
        await tx.$queryRaw<
          { version: number }[]
        >`SELECT COALESCE(MAX(version),0)+1 AS version FROM delivery_repository_policy_versions WHERE owner_id=${ownerId}::uuid AND policy_id=${p.id}::uuid`
      )[0].version;
      const versionId = randomUUID();
      await tx.$executeRaw`INSERT INTO delivery_repository_policy_versions(id,owner_id,project_id,policy_id,version,policy_digest,catalog_digest,source_policy,evidence_gates,acceptance_contracts,verified_identity,verified_identity_digest,created_by) VALUES(${versionId}::uuid,${ownerId}::uuid,${projectId}::uuid,${p.id}::uuid,${next},${policyDigest},${catalogDigest},${JSON.stringify(expected.policy.source)}::jsonb,${JSON.stringify(expected.policy.evidenceGates)}::jsonb,${JSON.stringify(expected.policy.acceptanceContracts)}::jsonb,${JSON.stringify(verifiedIdentity)}::jsonb,${identityDigest},'deployment:repository-policy-catalog-v1')`;
      await tx.$executeRaw`UPDATE delivery_repository_policies SET active_version_id=${versionId}::uuid,generation=generation+1 WHERE id=${p.id}::uuid AND generation=${p.generation}`;
      return { versionId, policyDigest, policy: expected.policy, verified };
    });
  }
  /** Called within the same transaction that INSERTs a new owner preparation
   * intent. It cannot retrofit a preexisting intent or silently change base ref. */
  async pinIntent(
    tx: Tx,
    input: {
      ownerId: string;
      projectId: string;
      repositoryId: string;
      providerAccountId: string;
      sourceSha: string;
      text: string;
    },
    selection: { versionId: string; policyDigest: string; verified: VerifiedRepository },
  ) {
    this.enabledOnly();
    const locked = await this.lockVersion(tx, input.ownerId, input.projectId, selection.versionId);
    if (
      locked.parent.activeVersionId !== selection.versionId ||
      locked.version.policyDigest !== selection.policyDigest ||
      input.repositoryId !== selection.verified.repositoryId ||
      input.providerAccountId !== selection.verified.providerAccountId
    )
      reject("repository_policy_selection_changed");
    if (locked.policy.source.baseBranch !== selection.verified.defaultBranch)
      reject("repository_policy_ref_resolution_pending");
    if (input.sourceSha !== selection.verified.defaultRevision)
      reject("repository_policy_source_changed");
    return {
      repositoryPolicyVersionId: selection.versionId,
      repositoryPolicyDigest: selection.policyDigest,
      intentTextDigest: repositoryPolicyTextDigest(input.text),
    };
  }
  private async lockVersion(tx: Tx, ownerId: string, projectId: string, versionId: string) {
    // Global order is project -> policy -> version, including importer/revoker.
    await tx.$queryRaw`SELECT id FROM delivery_projects WHERE owner_id=${ownerId}::uuid AND id=${projectId}::uuid FOR SHARE`;
    const parent = (
      await tx.$queryRaw<
        PolicyRow[]
      >`SELECT ${policyColumns} FROM delivery_repository_policies WHERE owner_id=${ownerId}::uuid AND project_id=${projectId}::uuid FOR UPDATE`
    )[0];
    const version = (
      await tx.$queryRaw<
        VersionRow[]
      >`SELECT ${versionColumns} FROM delivery_repository_policy_versions WHERE owner_id=${ownerId}::uuid AND project_id=${projectId}::uuid AND id=${versionId}::uuid FOR UPDATE`
    )[0];
    if (
      !parent ||
      !version ||
      parent.revokedAt ||
      version.revokedAt ||
      version.policyId !== parent.id
    )
      reject("repository_policy_revoked");
    const project = await tx.deliveryProject.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: projectId } },
    });
    if (
      project.provider !== "github" ||
      project.providerRepositoryId !== parent.repositoryId ||
      project.providerAccountId !== parent.providerAccountId ||
      project.fullName !== parent.fullName
    )
      reject("repository_policy_identity_changed");
    const policy = definition(version);
    if (
      githubSourceDigest(policy) !== version.policyDigest ||
      githubSourceDigest(version.verifiedIdentity) !== version.verifiedIdentityDigest
    )
      reject("repository_policy_corrupt");
    return { parent, version, policy };
  }
  async projectEnrolled(tx: Tx, ownerId: string, projectId: string) {
    return (
      (
        await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM delivery_repository_policies WHERE owner_id=${ownerId}::uuid AND project_id=${projectId}::uuid`
      ).length > 0
    );
  }
  async authorizeIntent(tx: Tx, ownerId: string, intentId: string) {
    const intent = await tx.projectTaskIntent.findUnique({
      where: { ownerId_id: { ownerId, id: intentId } },
    });
    if (!intent) reject("repository_policy_intent_unbound");
    if (!intent.repositoryPolicyVersionId) {
      if (this.enabled || (await this.projectEnrolled(tx, ownerId, intent.projectId)))
        reject("repository_policy_intent_unbound");
      return null;
    }
    this.enabledOnly();
    const bound = await this.lockVersion(
      tx,
      ownerId,
      intent.projectId,
      intent.repositoryPolicyVersionId,
    );
    if (
      bound.version.policyDigest !== intent.repositoryPolicyDigest ||
      !intent.intentTextDigest ||
      bound.parent.repositoryId !== intent.repositoryId ||
      bound.parent.providerAccountId !== intent.providerAccountId
    )
      reject("repository_policy_intent_unbound");
    return bound;
  }
  async bindCreatedTask(tx: Tx, ownerId: string, taskId: string, intentId: string) {
    this.enabledOnly();
    const task = await tx.deliveryTask.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: taskId } },
      include: {
        steps: { orderBy: { id: "asc" } },
        managerBinding: true,
        currentSourceRevision: true,
      },
    });
    const intent = (
      await tx.$queryRaw<
        {
          projectId: string;
          versionId: string | null;
          policyDigest: string | null;
          textDigest: string | null;
          sourceSha: string;
        }[]
      >`SELECT project_id AS "projectId",repository_policy_version_id AS "versionId",repository_policy_digest AS "policyDigest",intent_text_digest AS "textDigest",source_sha AS "sourceSha" FROM project_task_intents WHERE owner_id=${ownerId}::uuid AND id=${intentId}::uuid FOR UPDATE`
    )[0];
    if (
      !intent?.versionId ||
      !intent.policyDigest ||
      !intent.textDigest ||
      intent.projectId !== task.projectId ||
      task.managerBinding?.preparationIntentId !== intentId ||
      task.sourceVersion !== 0 ||
      task.sourceSha !== intent.sourceSha
    )
      reject("repository_policy_intent_unbound");
    const locked = await this.lockVersion(tx, ownerId, task.projectId, intent.versionId);
    if (locked.version.policyDigest !== intent.policyDigest)
      reject("repository_policy_selection_changed");
    const projection = compileRepositoryTaskPolicy(
      locked.policy,
      intent.textDigest,
      task.outcome,
      task.steps,
    );
    const binding = {
      ownerId,
      taskId,
      projectId: task.projectId,
      intentId,
      policyVersionId: intent.versionId,
      policyDigest: intent.policyDigest,
      intentTextDigest: intent.textDigest,
      outcomeDigest: projection.outcomeDigest,
      sourceBase: intent.sourceSha,
      compiledEvidencePolicy: projection.compiledEvidencePolicy,
      criterionCoverage: projection.criterionCoverage,
      pendingRequirements: projection.pendingRequirements,
    };
    const bindingDigest = githubSourceDigest(binding);
    await tx.$executeRaw`INSERT INTO delivery_task_policy_bindings(owner_id,task_id,project_id,intent_id,policy_version_id,policy_digest,binding_digest,intent_text_digest,outcome_digest,source_base,compiled_evidence_policy,criterion_coverage,pending_requirements) VALUES(${ownerId}::uuid,${taskId}::uuid,${task.projectId}::uuid,${intentId}::uuid,${intent.versionId}::uuid,${intent.policyDigest},${bindingDigest},${intent.textDigest},${projection.outcomeDigest},${intent.sourceSha},${JSON.stringify(projection.compiledEvidencePolicy)}::jsonb,${JSON.stringify(projection.criterionCoverage)}::jsonb,${JSON.stringify(projection.pendingRequirements)}::jsonb) ON CONFLICT(owner_id,task_id) DO NOTHING`;
    const saved = (
      await tx.$queryRaw<
        BindingRow[]
      >`SELECT ${bindingColumns} FROM delivery_task_policy_bindings WHERE owner_id=${ownerId}::uuid AND task_id=${taskId}::uuid`
    )[0];
    if (!saved || saved.bindingDigest !== bindingDigest)
      reject("repository_policy_binding_conflict");
    return saved;
  }
  /** Always check persistence before the feature selector: an enrolled task can
   * never regain weaker legacy map policy by disabling the rollout flag. */
  async resolveTask(tx: Tx, ownerId: string, taskId: string) {
    const binding = (
      await tx.$queryRaw<
        BindingRow[]
      >`SELECT ${bindingColumns} FROM delivery_task_policy_bindings WHERE owner_id=${ownerId}::uuid AND task_id=${taskId}::uuid`
    )[0];
    if (!binding) {
      const task = await tx.deliveryTask.findUnique({
        where: { ownerId_id: { ownerId, id: taskId } },
        select: { projectId: true },
      });
      if (this.enabled || (task && (await this.projectEnrolled(tx, ownerId, task.projectId))))
        reject("repository_policy_task_unbound");
      return null;
    }
    this.enabledOnly();
    const locked = await this.lockVersion(tx, ownerId, binding.projectId, binding.policyVersionId);
    const { bindingDigest, ...unsigned } = binding;
    if (
      githubSourceDigest(unsigned) !== bindingDigest ||
      binding.policyDigest !== locked.version.policyDigest
    )
      reject("repository_policy_binding_corrupt");
    const task = await tx.deliveryTask.findUniqueOrThrow({
      where: { ownerId_id: { ownerId, id: taskId } },
      include: {
        steps: { orderBy: { id: "asc" } },
        managerBinding: true,
        currentSourceRevision: true,
      },
    });
    if (
      task.projectId !== binding.projectId ||
      task.managerBinding?.preparationIntentId !== binding.intentId ||
      task.managerBinding.sourceSha !== binding.sourceBase
    )
      reject("repository_policy_binding_changed");
    const projection = compileRepositoryTaskPolicy(
      locked.policy,
      binding.intentTextDigest,
      task.outcome,
      task.steps,
    );
    if (
      !same(projection.compiledEvidencePolicy, binding.compiledEvidencePolicy) ||
      !same(projection.criterionCoverage, binding.criterionCoverage) ||
      !same(projection.pendingRequirements, binding.pendingRequirements) ||
      projection.outcomeDigest !== binding.outcomeDigest
    )
      reject("repository_policy_binding_changed");
    return { binding, policy: locked.policy, projection, task };
  }
  /** Trusted controller operation, not a manager/API payload. */
  async revokeVersion(ownerId: string, projectId: string, versionId: string) {
    this.enabledOnly();
    for (const value of [ownerId, projectId, versionId]) uuid.parse(value);
    return this.transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM delivery_projects WHERE owner_id=${ownerId}::uuid AND id=${projectId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM delivery_repository_policies WHERE owner_id=${ownerId}::uuid AND project_id=${projectId}::uuid FOR UPDATE`;
      await tx.$executeRaw`UPDATE delivery_repository_policy_versions SET revoked_at=clock_timestamp() WHERE owner_id=${ownerId}::uuid AND project_id=${projectId}::uuid AND id=${versionId}::uuid AND revoked_at IS NULL`;
    });
  }
}
