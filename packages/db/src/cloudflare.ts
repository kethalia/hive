import { PrismaNeon } from "@prisma/adapter-neon";
import type { PrismaClient } from "./generated/prisma/client";
import { PrismaClient as CloudflarePrismaClient } from "./generated/prisma-workerd/client";
import { createDatabaseRequest } from "./request-scope";

/** Lazy, request-local full-schema client. No socket is created in global scope. */
export function createCloudflareDatabaseRequest(
  databaseUrl: string | undefined,
  bounds?: { queryTimeoutMillis: number; transactionTimeoutMillis: number },
) {
  if (
    bounds &&
    [bounds.queryTimeoutMillis, bounds.transactionTimeoutMillis].some(
      (value) => !Number.isInteger(value) || value <= 0 || value > 10_000,
    )
  )
    throw new Error("[@hive/db] Invalid request-local timeout bounds");
  return createDatabaseRequest(() => {
    if (!databaseUrl) throw new Error("[@hive/db] DATABASE_URL is not configured");
    return new CloudflarePrismaClient({
      adapter: new PrismaNeon({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 10_000,
        ...(bounds ? { query_timeout: bounds.queryTimeoutMillis } : {}),
      }),
      transactionOptions: {
        maxWait: bounds?.transactionTimeoutMillis ?? 10_000,
        timeout: bounds?.transactionTimeoutMillis ?? 15_000,
      },
    }) as unknown as PrismaClient;
  });
}
