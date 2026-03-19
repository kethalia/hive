import IORedis from "ioredis";

let connection: IORedis | null = null;

/**
 * Returns a shared IORedis instance for BullMQ.
 * Uses lazy singleton pattern (same approach as db/index.ts).
 *
 * Critical: maxRetriesPerRequest must be null — BullMQ workers
 * block indefinitely on BRPOPLPUSH and will fail with timeout
 * errors if Redis retries are limited.
 */
export function getRedisConnection(): IORedis {
  if (!connection) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error(
        "[queue] REDIS_URL environment variable is not set. " +
          "Check .env.example for the required format."
      );
    }
    connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

/**
 * Closes the shared Redis connection. Call during graceful shutdown.
 */
export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
