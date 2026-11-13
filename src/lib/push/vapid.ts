import { getDb, type PrismaClient } from "@hive/db";
import webpush from "web-push";

let cachedKeys: { publicKey: string; privateKey: string } | null = null;

export async function getVapidKeys(database?: {
  vapidKeys: Pick<PrismaClient["vapidKeys"], "findUnique" | "upsert">;
}): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  if (!database && cachedKeys) return cachedKeys;

  const db = database ?? getDb();

  const existing = await db.vapidKeys.findUnique({ where: { id: 1 } });
  if (existing) {
    const keys = { publicKey: existing.publicKey, privateKey: existing.privateKey };
    if (!database) cachedKeys = keys;
    return keys;
  }

  const generated = webpush.generateVAPIDKeys();
  const row = await db.vapidKeys.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    },
  });

  const keys = { publicKey: row.publicKey, privateKey: row.privateKey };
  if (!database) cachedKeys = keys;
  return keys;
}

export async function getVapidPublicKey(): Promise<string> {
  const keys = await getVapidKeys();
  return keys.publicKey;
}

export function clearVapidCache(): void {
  cachedKeys = null;
}
