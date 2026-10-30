import { acceptanceProducerSchema } from "./acceptance-contracts";
import { ACCEPTANCE_PROMPT_DIGEST, ACCEPTANCE_SCHEMA_DIGEST } from "./acceptance-prompts";
/** Absent means unchanged legacy deployment. An explicit malformed selection
 * fails closed; no model, task metadata or host request selects this producer. */
export function acceptanceDeploymentConfig(env: Record<string, string | undefined> = process.env) {
  if (env.HIVE_DELIVERY_ACCEPTANCE_ENABLED !== "true") return null;
  if (
    env.HIVE_DELIVERY_EXECUTION_ENABLED !== "true" ||
    env.HIVE_DELIVERY_MANAGER_ENABLED !== "true" ||
    env.HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED !== "true"
  )
    throw new Error("Acceptance requires enrolled guarded delivery execution");
  const raw = env.HIVE_DELIVERY_ACCEPTANCE_PRODUCER;
  if (!raw || Buffer.byteLength(raw) > 4096) throw new Error("Acceptance producer unavailable");
  const producer = acceptanceProducerSchema.parse(JSON.parse(raw));
  if (
    producer.promptDigest !== ACCEPTANCE_PROMPT_DIGEST ||
    producer.schemaDigest !== ACCEPTANCE_SCHEMA_DIGEST ||
    producer.permissionsDigest !==
      "5cb0236664ba9833dc964200828cc6b650583eb0b7d2bd43d587889c5a9b175b"
  )
    throw new Error("Acceptance protocol mismatch");
  return producer;
}
