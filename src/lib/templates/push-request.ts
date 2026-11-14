"use client";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function key(userId: string, name: string) {
  return `hive-template-push:v1:${userId}:${name}`;
}

/** Persist before POST so a lost response can replay the same durable job. */
export function pendingTemplatePush(userId: string, name: string): string {
  if (!userId || !name) throw Error("Template publication identity unavailable");
  const storageKey = key(userId, name);
  const existing = sessionStorage.getItem(storageKey);
  if (existing) {
    if (!uuid.test(existing)) throw Error("Pending publication identity is invalid");
    return existing;
  }
  const requestId = crypto.randomUUID();
  sessionStorage.setItem(storageKey, requestId);
  return requestId;
}

/** A stale stream callback cannot erase a newer pending operation. */
export function completeTemplatePush(userId: string, name: string, requestId: string) {
  const storageKey = key(userId, name);
  if (sessionStorage.getItem(storageKey) === requestId) sessionStorage.removeItem(storageKey);
}
