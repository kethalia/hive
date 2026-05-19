import { Prisma, PrismaClient } from "@prisma/client";

export { Prisma, PrismaClient };
export type * from "@prisma/client";

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
