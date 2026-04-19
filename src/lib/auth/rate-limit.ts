import { checkRateLimit } from "@hive/auth";
import type { RateLimitResult } from "@hive/auth";

export const loginRateLimiter = {
  check(ip: string): RateLimitResult {
    return checkRateLimit(ip, 5, 60_000);
  },
};
