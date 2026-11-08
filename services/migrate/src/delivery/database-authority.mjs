import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { requireValue } from "./contracts.mjs";

const schema = z
  .array(
    z
      .object({
        ownerId: z.string().uuid(),
        repositoryId: z.string().regex(/^[1-9][0-9]*$/),
        origin: z.string().url(),
        publicKeyPem: z.string().min(40).max(4096),
        targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
        databaseHost: z.string(),
        databasePort: z.number().int(),
        databaseName: z.string(),
      })
      .strict(),
  )
  .max(32);
const key = (pem) => {
  const k = createPublicKey(pem);
  requireValue(k.asymmetricKeyType === "ed25519", "migration_authority_not_enrolled");
  return k.export({ type: "spki", format: "der" }).toString("hex");
};
/** Deployment-owned public metadata from the fixed reviewed recipe, never catalog inputs. */
export function readDatabaseAuthorities() {
  return schema.parse(
    JSON.parse(readFileSync(new URL("./database-authorities.json", import.meta.url), "utf8")),
  );
}
export function assertDatabaseAuthority(
  catalog,
  recipeSha,
  manifest = readDatabaseAuthorities(),
  automaticDispatch = false,
) {
  const config = catalog.compatibilityTest?.config;
  if (automaticDispatch)
    requireValue(config?.kind === "automatic-source-build", "migration_authority_not_enrolled");
  if (config?.kind !== "automatic-source-build") return;
  requireValue(
    /^[a-f0-9]{40}$/.test(recipeSha ?? "") && config.recipeSha === recipeSha,
    "migration_recipe_not_enrolled",
  );
  const matching = schema
    .parse(manifest)
    .filter(
      (v) =>
        v.ownerId === catalog.ownerId &&
        v.repositoryId === catalog.repositoryId &&
        v.targetDigest === catalog.targetDigest &&
        v.origin === catalog.authorityOrigin &&
        v.databaseHost === catalog.databaseHost &&
        v.databasePort === catalog.databasePort &&
        v.databaseName === catalog.databaseName &&
        key(v.publicKeyPem) === key(catalog.authorityPublicKeyPem),
    );
  requireValue(matching.length === 1, "migration_authority_not_enrolled");
}
