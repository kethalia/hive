import type { RateLimitResult } from "@hive/auth";
import { checkRateLimit } from "@hive/auth";

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const loginRateLimiter = {
  check(ip: string): RateLimitResult {
    return checkRateLimit(ip, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS);
  },
};
