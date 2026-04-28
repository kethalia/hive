import { PrismaClient } from "../generated/prisma/index.js";

let prisma: PrismaClient | null = null;

export function getDb(): PrismaClient {
  if (!prisma) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "[auth-service] DATABASE_URL environment variable is not set."
      );
    }
    prisma = new PrismaClient();
  }
  return prisma;
}

export async function closeDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
