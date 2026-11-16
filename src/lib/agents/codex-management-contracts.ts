import { z } from "zod";

// Usage/config display contracts adapted from CCS main 86b3df8, PR 112.
const field = z.string().max(160);
const text = z.string().max(2048);
const count = z.number().int().nonnegative().safe();
const windowSchema = z
  .object({
    usedPercent: z.number().min(0).max(100),
    minutes: z.number().nonnegative().nullable(),
    resetsAt: z.number().int().nullable(),
  })
  .strict();
export const codexUsageSchema = z
  .object({
    limitsAvailable: z.boolean(),
    usageAvailable: z.boolean(),
    windows: z
      .array(
        z
          .object({
            id: field,
            name: field,
            primary: windowSchema.nullable(),
            secondary: windowSchema.nullable(),
          })
          .strict(),
      )
      .max(100),
    credits: z
      .object({ balance: text.nullable(), unlimited: z.boolean().nullable() })
      .strict()
      .nullable(),
    resetCredits: count.nullable(),
    resets: z
      .array(
        z
          .object({
            id: text.min(1),
            title: z.string().max(500).nullable(),
            description: z.string().max(2000).nullable(),
            resetType: z.enum(["codexRateLimits", "unknown"]),
            status: z.enum(["available", "redeeming", "redeemed", "unknown"]),
            grantedAt: z.number().int().nullable(),
            expiresAt: z.number().int().nullable(),
          })
          .strict(),
      )
      .max(1000)
      .nullable(),
    tokens: z
      .object({
        lifetime: count.nullable(),
        peakDaily: count.nullable(),
        daily: z.array(z.object({ date: z.string().max(32), tokens: count }).strict()).max(400),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CodexUsage = z.infer<typeof codexUsageSchema>;
export const codexConfigValuesSchema = z
  .object({
    model: field.nullable(),
    review_model: field.nullable(),
    model_reasoning_effort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
      .nullable(),
    model_verbosity: z.enum(["low", "medium", "high"]).nullable(),
    web_search: z.enum(["disabled", "cached", "live"]).nullable(),
    service_tier: field.nullable(),
  })
  .strict();
export const codexConfigSchema = z
  .object({
    version: text.min(1),
    values: codexConfigValuesSchema,
    origins: z.record(field),
    models: z
      .array(
        z
          .object({
            id: field,
            name: field,
            efforts: z.array(field).max(20),
            tiers: z.array(z.object({ id: field, name: field }).strict()).max(20),
          })
          .strict(),
      )
      .max(200),
    truncated: z.boolean(),
    approvalPolicy: field.nullable(),
    sandboxMode: field.nullable(),
  })
  .strict();
export type CodexConfig = z.infer<typeof codexConfigSchema>;
const fence = { lifetimeId: z.string().uuid(), generation: count };
export const codexManagementRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("usage"), ...fence }).strict(),
  z.object({ action: z.literal("config"), ...fence }).strict(),
  z
    .object({
      action: z.literal("save-config"),
      ...fence,
      version: text.min(1),
      values: codexConfigValuesSchema.partial().refine((values) => Object.keys(values).length > 0),
    })
    .strict(),
]);
export type CodexManagementRequest = z.infer<typeof codexManagementRequestSchema>;
export const codexManagementResponseSchema = z
  .object({
    scope: z.literal("managed-native"),
    ...fence,
    outcome: z.enum(["read", "saved", "unknown"]),
    usage: codexUsageSchema.nullable(),
    config: codexConfigSchema.nullable(),
    overridden: z.boolean().nullable(),
  })
  .strict();
export type CodexManagementResponse = z.infer<typeof codexManagementResponseSchema>;
