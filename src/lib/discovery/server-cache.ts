import { createHash } from "node:crypto";
import Redis from "ioredis";

const BUMP_GENERATION = `local version = redis.call("INCR", KEYS[1]); redis.call("PEXPIRE", KEYS[1], ARGV[1]); return version`;
const MAX_ENTRIES = 256;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_VALUE_BYTES = 1024 * 1024;
const memory = new Map<string, { value: string; expires: number; bytes: number }>();
const pending = new Map<string, Promise<unknown>>();
let memoryBytes = 0;
let redis: Redis | undefined;
let connecting: Promise<Redis | undefined> | undefined;
let retryAt = 0;

// Interactive reads must never inherit BullMQ's indefinite retry/offline queue.
async function connection(): Promise<Redis | undefined> {
  if (!process.env.REDIS_URL) return undefined;
  if (redis?.status === "ready") return redis;
  if (connecting) return connecting;
  if (Date.now() < retryAt) return undefined;
  retryAt = Date.now() + 30_000;
  redis?.disconnect();
  const client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 200,
    commandTimeout: 200,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  client.on("error", () => {});
  redis = client;
  connecting = client
    .connect()
    .then(
      () => client,
      () => undefined,
    )
    .finally(() => {
      connecting = undefined;
    });
  return connecting;
}

function remove(key: string) {
  memoryBytes -= memory.get(key)?.bytes ?? 0;
  memory.delete(key);
}
function remember(key: string, value: string, ttl: number) {
  const bytes = Buffer.byteLength(value);
  if (bytes > MAX_VALUE_BYTES) return;
  remove(key);
  const now = Date.now();
  for (const [entryKey, entry] of memory) if (entry.expires <= now) remove(entryKey);
  while (memory.size >= MAX_ENTRIES || memoryBytes + bytes > MAX_BYTES) {
    const oldest = memory.keys().next().value;
    if (!oldest) break;
    remove(oldest);
  }
  memory.set(key, { value, bytes, expires: now + ttl });
  memoryBytes += bytes;
}

export function discoveryCacheKey(parts: string[]): string {
  return `hive:discovery:v1:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/** Cache only successful, validated discovery metadata, after fresh authorization. */
export async function cachedDiscovery<T>({
  key,
  ttl,
  load,
  refresh = false,
  cacheable = () => true,
}: {
  key: string;
  ttl: number;
  load: () => Promise<T>;
  refresh?: boolean;
  cacheable?: (value: T) => boolean;
}): Promise<T> {
  const client = await connection();
  let epoch = "local";
  try {
    if (client) {
      // Generations prevent an older in-flight scan in another pod from repopulating
      // the current cache after a refresh/mutation. All Redis keys have bounded lifetimes.
      if (refresh) {
        epoch = String(await client.eval(BUMP_GENERATION, 1, `${key}:generation`, 172_800_000));
      } else epoch = (await client.get(`${key}:generation`)) ?? "0";
    }
  } catch {
    epoch = "local";
  }
  const entryKey = `${key}:${epoch}`;
  if (refresh) {
    for (const existing of memory.keys()) if (existing.startsWith(`${key}:`)) remove(existing);
    pending.delete(entryKey);
  } else {
    const entry = memory.get(entryKey);
    if (entry && entry.expires > Date.now()) return JSON.parse(entry.value) as T;
    remove(entryKey);
    if (pending.has(entryKey)) return pending.get(entryKey) as Promise<T>;
  }
  let operation!: Promise<T>;
  operation = (async () => {
    if (client && epoch !== "local" && !refresh) {
      try {
        const value = await client.get(entryKey);
        if (value && Buffer.byteLength(value) <= MAX_VALUE_BYTES) {
          // Do not extend the server lifetime when loading a shared value locally.
          const remaining = await client.pttl(entryKey);
          if (remaining > 0) {
            remember(entryKey, value, remaining);
            return JSON.parse(value) as T;
          }
        }
      } catch {
        /* Cache outages cannot prevent discovery. */
      }
    }
    const result = await load();
    const value = JSON.stringify(result);
    if (
      pending.get(entryKey) === operation &&
      cacheable(result) &&
      Buffer.byteLength(value) <= MAX_VALUE_BYTES
    ) {
      remember(entryKey, value, ttl);
      if (client && epoch !== "local") {
        try {
          await client.set(entryKey, value, "PX", ttl);
        } catch {
          /* Best effort. */
        }
      }
    }
    return result;
  })();
  pending.set(entryKey, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(entryKey) === operation) pending.delete(entryKey);
  }
}

export async function invalidateDiscovery(key: string) {
  for (const existing of memory.keys()) if (existing.startsWith(`${key}:`)) remove(existing);
  for (const existing of pending.keys())
    if (existing.startsWith(`${key}:`)) pending.delete(existing);
  const client = await connection();
  if (client) {
    try {
      await client.eval(BUMP_GENERATION, 1, `${key}:generation`, 172_800_000);
    } catch {
      /* Local invalidation still applies when Valkey is unavailable. */
    }
  }
}
