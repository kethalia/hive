import type { RateLimitResult } from "@hive/auth";
import { checkRateLimit } from "@hive/auth";
import { RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS } from "./constants.js";

export const loginRateLimiter = {
  check(ip: string): RateLimitResult {
    return checkRateLimit(ip, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS);
  },
};
