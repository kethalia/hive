import pkg from "@prisma/client";

// Prisma 6's @prisma/client is CJS; with `"type": "module"` in this package,
// Node's ESM loader can't reliably statically-detect named exports on it, so
// `import { PrismaClient } from "@prisma/client"` throws at runtime with
// `does not provide an export named 'PrismaClient'`. Destructure the default
// (interop) import to get the runtime values; types come via the type-only
// re-export below, which is erased at compile time.
const { PrismaClient } = pkg;

export { PrismaClient };
export type * from "@prisma/client";

type PrismaClient = InstanceType<typeof PrismaClient>;

let client: PrismaClient | null = null;

/**
 * Returns a process-wide PrismaClient singleton.
 *
 * Lazy-initialized on first call. Reads DATABASE_URL from the environment
 * and throws if it's missing — callers should not catch this; misconfigured
 * environments must fail loudly at startup.
 */
export function getDb(): PrismaClient {
  if (!client) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "[@hive/db] DATABASE_URL environment variable is not set. " +
          "Check .env.example for the required format.",
      );
    }
    client = new PrismaClient();
  }
  return client;
}

/** Disconnects the singleton. Call during graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
