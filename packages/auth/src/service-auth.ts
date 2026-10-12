import { HEX_64_RE } from "./constants";

/** Internal service authority is separate from browser sessions and Coder tokens. */
export function authServiceHeaders(secret = process.env.AUTH_SERVICE_SECRET): {
  Authorization: string;
} {
  if (!secret || !HEX_64_RE.test(secret)) {
    throw new Error("AUTH_SERVICE_SECRET must be exactly 64 hex characters (32 bytes)");
  }
  return { Authorization: `Bearer ${secret}` };
}
