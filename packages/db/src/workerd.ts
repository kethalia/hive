import type { PrismaClient as NodePrismaClient } from "./generated/prisma/client";
import { getRequestDb } from "./request-scope";

// Runtime exports must come from the workerd generator. Merely importing the
// Node client eagerly initializes native-engine paths before getDb() is called.
export type * from "./generated/prisma/client";
export { Prisma, PrismaClient } from "./generated/prisma-workerd/client";
export { createDatabaseRequest } from "./request-scope";

export function getDb(): NodePrismaClient {
  const client = getRequestDb();
  if (!client) throw new Error("[@hive/db] Cloudflare database request context is missing");
  return client;
}

export async function closeDb(): Promise<void> {
  throw new Error("[@hive/db] Cloudflare clients close with their request lifetime");
}
