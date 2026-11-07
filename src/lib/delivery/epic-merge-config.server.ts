import { epicMergeConfigSchema } from "./epic-merge-contracts";
export function configuredEpicMerge(env: Record<string, string | undefined> = process.env) {
  if (env.HIVE_DELIVERY_EPICS_ENABLED !== "true" || env.HIVE_DELIVERY_EPIC_MERGE_ENABLED !== "true")
    return null;
  const raw = env.HIVE_DELIVERY_EPIC_MERGE_CONFIG_JSON;
  if (!raw || Buffer.byteLength(raw) > 8192) throw Error("epic_merge_unavailable");
  return epicMergeConfigSchema.parse(JSON.parse(raw));
}
