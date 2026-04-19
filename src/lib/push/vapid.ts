import webpush from "web-push";
import { getDb } from "@/lib/db";

let cachedKeys: { publicKey: string; privateKey: string } | null = null;

export async function getVapidKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  if (cachedKeys) return cachedKeys;

  const db = getDb();

  const existing = await db.vapidKeys.findUnique({ where: { id: 1 } });
  if (existing) {
    cachedKeys = { publicKey: existing.publicKey, privateKey: existing.privateKey };
    return cachedKeys;
  }

  const generated = webpush.generateVAPIDKeys();
  await db.vapidKeys.create({
    data: {
      id: 1,
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    },
  });

  cachedKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  return cachedKeys;
}

export async function getVapidPublicKey(): Promise<string> {
  const keys = await getVapidKeys();
  return keys.publicKey;
}

export function clearVapidCache(): void {
  cachedKeys = null;
}
