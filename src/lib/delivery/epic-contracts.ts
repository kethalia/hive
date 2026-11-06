import { createHash } from "node:crypto";
import { z } from "zod";

const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const criterion = z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/);
/** Manager-authored decomposition is bounded by the immutable owner intent,
 * exact criterion identities and separately enrolled independent workspaces. */
export const epicPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    epicId: uuid,
    projectId: uuid,
    ownerIntentDigest: digest,
    outcomeDigest: digest,
    criteria: z.array(criterion).min(1).max(20),
    version: z.number().int().positive().max(1000),
    previousPlanDigest: digest.nullable(),
    maxConcurrentTasks: z.number().int().min(1).max(2),
    tasks: z
      .array(
        z
          .object({
            intentId: uuid,
            requestId: uuid,
            workspaceId: uuid,
            expectedRevision: sha,
            textDigest: digest,
            criteria: z.array(criterion).min(1).max(20),
            dependsOn: z.array(uuid).max(16),
            role: z.enum(["implementation", "integration"]),
            managerKey: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
              .optional(),
            modelTier: z
              .string()
              .regex(/^[a-z][a-z0-9_-]{0,31}$/)
              .optional(),
            model: z
              .string()
              .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
              .optional(),
            effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (new Set(plan.criteria).size !== plan.criteria.length) issue("duplicate criteria");
    if ((plan.version === 1) !== (plan.previousPlanDigest === null)) issue("invalid plan chain");
    const ids = new Set(plan.tasks.map((t) => t.intentId));
    if (
      ids.size !== plan.tasks.length ||
      new Set(plan.tasks.map((t) => t.requestId)).size !== plan.tasks.length
    )
      issue("duplicate task identity");
    const integration = plan.tasks.filter((t) => t.role === "integration");
    if (integration.length !== 1) issue("one integration task required");
    if (!plan.tasks.some((t) => t.role === "implementation"))
      issue("at least one implementation task required");
    for (const task of plan.tasks) {
      if (
        [task.modelTier, task.model, task.effort].filter((value) => value !== undefined).length %
          3 !==
        0
      )
        issue("incomplete model selection");
      if (
        new Set(task.criteria).size !== task.criteria.length ||
        task.criteria.some((c) => !plan.criteria.includes(c))
      )
        issue("unknown or duplicate criterion");
      if (
        new Set(task.dependsOn).size !== task.dependsOn.length ||
        task.dependsOn.some((id) => id === task.intentId || !ids.has(id))
      )
        issue("invalid task dependency");
    }
    const managerKeys = plan.tasks.flatMap((task) => (task.managerKey ? [task.managerKey] : []));
    if (new Set(managerKeys).size !== managerKeys.length) issue("duplicate manager task key");
    const byId = new Map(plan.tasks.map((t) => [t.intentId, t]));
    const visited = new Set<string>(),
      active = new Set<string>();
    const visit = (id: string): boolean => {
      if (active.has(id)) return false;
      if (visited.has(id)) return true;
      active.add(id);
      for (const dep of byId.get(id)?.dependsOn ?? []) if (!visit(dep)) return false;
      active.delete(id);
      visited.add(id);
      return true;
    };
    if ([...ids].some((id) => !visit(id))) issue("cyclic task dependency");
    if (integration.length === 1) {
      const integrationTask = integration[0];
      if (plan.criteria.some((c) => !integrationTask.criteria.includes(c)))
        issue("integration must cover all criteria");
      const ancestors = new Set<string>();
      const collect = (id: string) => {
        if (ancestors.has(id)) return;
        ancestors.add(id);
        for (const dep of byId.get(id)?.dependsOn ?? []) collect(dep);
      };
      for (const dep of integrationTask.dependsOn) collect(dep);
      if (plan.tasks.some((t) => t.role === "implementation" && !ancestors.has(t.intentId)))
        issue("integration must follow all implementation tasks");
    }
    if (Buffer.byteLength(JSON.stringify(plan)) > 131072) issue("plan byte limit");
  });
export const epicPlanInputSchema = z
  .object({
    plan: epicPlanSchema,
    inputs: z
      .array(
        z
          .object({
            intentId: z.string().uuid(),
            text: z
              .string()
              .min(1)
              .refine(
                (v) =>
                  v === v.trim() &&
                  ![...v].some((c) => {
                    const n = c.charCodeAt(0);
                    return (n < 32 && ![9, 10, 13].includes(n)) || n === 127;
                  }),
              )
              .refine((v) => Buffer.byteLength(v, "utf8") <= 32768),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
export const managerEpicProposalSchema = z
  .object({
    taskId: z.string().uuid(),
    expectedPlanVersion: z.number().int().nonnegative().max(999),
    expectedPlanDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    maxConcurrentTasks: z.number().int().min(1).max(2),
    tasks: z
      .array(
        z
          .object({
            key,
            workspaceId: z.string().uuid(),
            expectedRevision: z.string().regex(/^[a-f0-9]{40}$/),
            text: z.string().min(1).max(32768),
            criteria: z.array(z.string()).min(1).max(20),
            dependsOn: z.array(key).max(16),
            role: z.enum(["implementation", "integration"]),
            modelTier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

export type EpicPlan = z.infer<typeof epicPlanSchema>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const epicDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
