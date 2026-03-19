import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient | null = null;

/**
 * Returns a PrismaClient singleton.
 * Lazy-initialized on first call, reused thereafter.
 */
export function getDb(): PrismaClient {
  if (!prisma) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "[db] DATABASE_URL environment variable is not set. " +
          "Check .env.example for the required format."
      );
    }
    prisma = new PrismaClient();
  }
  return prisma;
}

/**
 * Disconnects PrismaClient. Call during graceful shutdown.
 */
export async function closeDb() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
