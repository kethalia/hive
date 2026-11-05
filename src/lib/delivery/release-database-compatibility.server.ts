import { z } from "zod";
import { databaseCatalogSchema } from "../../../services/migrate/src/delivery/wire.mjs";
import {
  latestDatabaseObservationId,
  verifyDatabaseCompatibility,
} from "./database-job-store.server";
import { githubSourceDigest } from "./github-evidence.server";
import type { createReleaseAuthorizer } from "./release-authority.server";
import { releaseBaselinesSchema } from "./release-baseline-contracts";
import { releaseBuildManifestSchema } from "./release-build-attestation.server";

type DatabaseVerifier = NonNullable<
  Parameters<typeof createReleaseAuthorizer>[0]["verifyDatabase"]
>;
type DeploymentVerifier = (
  tx: Parameters<DatabaseVerifier>[0],
  context: Parameters<DatabaseVerifier>[1],
) => Promise<boolean>;

/** Installed only with a separate trusted, persisted deployment evidence verifier.
 * It performs no network I/O while the release transaction is locked. */
export function releaseDatabaseCompatibility(
  catalogs: () => unknown,
  verifyDeployment: DeploymentVerifier,
): DatabaseVerifier {
  return async (tx, context) => {
    try {
      if (context.identity.kind !== "promote" && context.identity.kind !== "recover") return false;
      const now = (
        await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
      )[0].now.getTime();
      const matching = z
        .array(databaseCatalogSchema)
        .max(32)
        .parse(catalogs())
        .filter(
          (catalog) =>
            catalog.ownerId === context.ownerId &&
            catalog.targetDigest === context.identity.targetDigest &&
            githubSourceDigest(catalog) === context.database.catalogDigest &&
            catalog.validFrom <= now &&
            catalog.expiresAt > now,
        );
      if (matching.length !== 1) return false;
      const rows = await tx.$queryRaw<
        {
          snapshot: unknown;
          manifest: unknown;
          manifest_digest: string;
          evidence: unknown;
          evidence_digest: string;
        }[]
      >`
        SELECT r.snapshot,b.manifest,b.manifest_digest,v.evidence,v.evidence_digest FROM delivery_releases r
        JOIN delivery_release_build_attestations b ON b.release_id=r.id AND b.owner_id=r.owner_id
        JOIN delivery_release_build_verifications v ON v.attestation_id=b.id AND v.owner_id=b.owner_id
        WHERE r.id=${context.identity.releaseId}::uuid AND r.owner_id=${context.ownerId}::uuid`;
      if (
        rows.length !== 1 ||
        githubSourceDigest(rows[0].manifest) !== rows[0].manifest_digest ||
        githubSourceDigest(rows[0].evidence) !== rows[0].evidence_digest
      )
        return false;
      const verification = z
        .object({
          status: z.literal("completed"),
          conclusion: z.literal("success"),
          manifestDigest: z.string(),
        })
        .passthrough()
        .parse(rows[0].evidence);
      if (verification.manifestDigest !== rows[0].manifest_digest) return false;
      const baseline = z
        .object({ baselines: releaseBaselinesSchema })
        .passthrough()
        .parse(rows[0].snapshot).baselines;
      const build = releaseBuildManifestSchema.parse(rows[0].manifest);
      const compatibilityConfig = matching[0].compatibilityTest?.config;
      if (
        !compatibilityConfig ||
        !("kind" in compatibilityConfig) ||
        compatibilityConfig.kind !== "workerd" ||
        compatibilityConfig.oldAuthDigest !== baseline.auth.artifactDigest ||
        compatibilityConfig.newAuthDigest !== build.auth.artifactDigest
      )
        return false;
      if (
        build.releaseId !== context.identity.releaseId ||
        build.ownerId !== context.ownerId ||
        build.targetDigest !== context.identity.targetDigest
      )
        return false;
      const observationId = await latestDatabaseObservationId(tx, {
        ownerId: context.ownerId,
        taskId: context.taskId,
        releaseId: context.identity.releaseId,
        generation: context.identity.generation,
        planEventId: context.database.planEventId,
      });
      await verifyDatabaseCompatibility(
        tx,
        {
          ownerId: context.ownerId,
          taskId: context.taskId,
          sourceSha: context.sourceSha,
          targetDigest: context.identity.targetDigest,
          releaseId: context.identity.releaseId,
          generation: context.identity.generation,
          action: context.identity.kind,
          planEventId: context.database.planEventId,
          observationId,
          catalog: matching[0],
          signal: AbortSignal.timeout(5000),
        },
        async (input) =>
          input.observation.oldAppDigest === baseline.app.artifactDigest &&
          input.observation.newAppDigest === build.app.artifactDigest &&
          (await verifyDeployment(tx, context)),
      );
      return true;
    } catch {
      return false;
    }
  };
}
