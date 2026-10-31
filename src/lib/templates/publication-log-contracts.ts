import { z } from "zod";
import { publicationStageSchema } from "./publication-contracts";

export const TEMPLATE_LOG_LIMITS = {
  records: 128,
  bytes: 262144,
  rowBytes: 32768,
  chunks: 4096,
  readMs: 5000,
  routeMs: 15000,
} as const;
export const templateLogCursorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= BigInt("9223372036854775807"));
export const templateLogFallbackSchema = z.enum([
  "malformed",
  "row_too_large",
  "byte_limit",
  "record_limit",
  "chunk_limit",
  "deadline",
  "provider_unavailable",
]);
export type TemplateLogFallback = z.infer<typeof templateLogFallbackSchema>;
export const templateLogRecordSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  output: z.string(),
  stage: z.string().max(256).optional(),
  level: z.string().max(32).optional(),
});
export type TemplateLogRecord = { id: string; output: string; stage?: string; level?: string };
export type TemplateLogPage = {
  records: TemplateLogRecord[];
  nextAfter: string;
  hasMore: boolean;
  fallback: TemplateLogFallback | null;
};
export const templateLogResponseSchema = z
  .object({
    records: z
      .array(
        z.object({
          id: templateLogCursorSchema.refine((value) => value !== "0"),
          output: z.string().max(TEMPLATE_LOG_LIMITS.rowBytes),
          stage: z.string().max(256).optional(),
          level: z.string().max(32).optional(),
        }),
      )
      .max(TEMPLATE_LOG_LIMITS.records),
    nextAfter: templateLogCursorSchema,
    hasMore: z.boolean(),
    fallback: templateLogFallbackSchema.nullable(),
    available: z.boolean(),
    stage: publicationStageSchema,
    coderUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          /^\/templates(?:\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/versions\/[A-Za-z0-9_.-]+)?$/.test(
            url.pathname,
          )
        );
      }),
    viewScope: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type TemplateLogResponse = z.infer<typeof templateLogResponseSchema>;
