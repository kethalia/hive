import { z } from "zod";
import { epicIsolationSchema } from "./epic-claim.server";

const tierSchema = z
  .object({
    tier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]),
  })
  .strict();
/** Model choices are deployment-owned; the default remains the configured
 * manager pair. A manager chooses only named, explicitly approved tiers. */
export function epicModelTiers(env: Record<string, string | undefined> = process.env) {
  const fallback = tierSchema.parse({
    tier: "default",
    model: env.HIVE_CODEX_MANAGER_MODEL,
    effort: env.HIVE_CODEX_MANAGER_EFFORT,
  });
  const raw = env.HIVE_DELIVERY_EPIC_MODEL_TIERS_JSON;
  if (!raw) return [fallback];
  if (Buffer.byteLength(raw) > 8192) throw new Error("Epic model catalog unavailable");
  const tiers = z.array(tierSchema).min(1).max(8).parse(JSON.parse(raw));
  if (
    new Set(tiers.map((value) => value.tier)).size !== tiers.length ||
    !tiers.some(
      (value) =>
        value.tier === "default" &&
        value.model === fallback.model &&
        value.effort === fallback.effort,
    )
  )
    throw new Error("Epic model catalog unavailable");
  return tiers;
}
/** Deployment-owned enrollment must come from reviewed provisioner policy,
 * never a manager tool call or a workspace-supplied identity. */
export function epicConfig() {
  if (process.env.HIVE_DELIVERY_EPICS_ENABLED !== "true") return null;
  if (!process.env.ENCRYPTION_KEY || !process.env.HIVE_DELIVERY_EPIC_ISOLATION_POLICY)
    throw new Error("Epic policy unavailable");
  return {
    encryptionKey: process.env.ENCRYPTION_KEY,
    isolationPolicy: epicIsolationSchema.parse(
      JSON.parse(process.env.HIVE_DELIVERY_EPIC_ISOLATION_POLICY),
    ),
    lineageToken: process.env.HIVE_DELIVERY_EPIC_GITHUB_READ_TOKEN ?? "",
    modelTiers: epicModelTiers(),
  };
}
