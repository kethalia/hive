import { PrismaNeon } from "@prisma/adapter-neon";
import type { PrismaClient } from "./generated/prisma/client";
import { PrismaClient as CloudflarePrismaClient } from "./generated/prisma-workerd/client";
import { createDatabaseRequest } from "./request-scope";

/** Lazy, request-local full-schema client. No socket is created in global scope. */
export function createCloudflareDatabaseRequest(databaseUrl: string | undefined) {
  return createDatabaseRequest(() => {
    if (!databaseUrl) throw new Error("[@hive/db] DATABASE_URL is not configured");
    return new CloudflarePrismaClient({
      adapter: new PrismaNeon({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 10_000,
      }),
      transactionOptions: { maxWait: 10_000, timeout: 15_000 },
    }) as unknown as PrismaClient;
  });
}
