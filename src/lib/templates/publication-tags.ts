import { createHash } from "node:crypto";
import { z } from "zod";
import { TemplatePublicationError } from "./publication-contracts";

const controlFree = (value: string) =>
  Array.from(value).every(
    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  );
const field = z.string().max(1024).refine(controlFree);
const schema = z.record(z.string().min(1).max(128).refine(controlFree), field);
/** Values are ephemeral provider inputs. Persist only the bounded canonical digest. */
export function canonicalProvisionerTags(value: unknown): Record<string, string> {
  const parsed = schema.safeParse(value);
  if (!parsed.success || Object.keys(parsed.data).length > 64)
    throw new TemplatePublicationError("provider_identity_mismatch");
  const result = Object.fromEntries(
    Object.keys(parsed.data)
      .sort()
      .map((key) => [key, parsed.data[key]]),
  );
  if (new TextEncoder().encode(JSON.stringify(result)).length > 16384)
    throw new TemplatePublicationError("provider_response_limit");
  return result;
}
export function provisionerTagsDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalProvisionerTags(value)))
    .digest("hex");
}
