import { createRequire } from "node:module";
import { requireValue } from "./contracts.mjs";
export const PINNED_PRISMA_LOCK = Object.freeze({
  version: "6.19.3",
  enginesVersion: "c2990dca591cba766e3b7ef5d9e8a84796e47ab7",
  key: "72707369",
});
/** Reviewed interoperability with the exact pinned engine's reserved lock.
 * Never substitute a parent/wrapper connection for the engine's own session.
 * Upgrading Prisma requires revalidating source and the real contention tests. */
export function assertPrismaLockContract(env = process.env) {
  const require = createRequire(import.meta.url);
  const cli = require("prisma/package.json");
  const cliRequire = createRequire(require.resolve("prisma/package.json"));
  const engine = cliRequire("@prisma/engines/package.json");
  const engineRequire = createRequire(cliRequire.resolve("@prisma/engines/package.json"));
  const { enginesVersion } = engineRequire("@prisma/engines-version");
  requireValue(
    cli.version === PINNED_PRISMA_LOCK.version &&
      engine.version === PINNED_PRISMA_LOCK.version &&
      enginesVersion === PINNED_PRISMA_LOCK.enginesVersion &&
      ![
        "PRISMA_SCHEMA_ENGINE_BINARY",
        "PRISMA_MIGRATION_ENGINE_BINARY",
        "PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK",
        "PRISMA_SCHEMA_ENGINE_WS_BASE_URL",
      ].some((key) => env[key] !== undefined),
    "migration_prisma_lock_contract_changed",
  );
  return PINNED_PRISMA_LOCK;
}
export async function acquirePrismaInteroperabilityLock(tx) {
  const row = (
    await tx.$queryRawUnsafe("SELECT pg_try_advisory_xact_lock(72707369::bigint) AS acquired")
  )[0];
  requireValue(row?.acquired === true, "migration_prisma_busy");
}
