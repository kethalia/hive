import { coderAuthCookieValues } from "@hive/auth";
import { constantTimeEqual, makeSignature } from "better-auth/crypto";

/** Middleware checks the framework signature. Session liveness remains server-owned. */
export async function validCoderAuthCookie(header: string | null, secret: string) {
  const values = coderAuthCookieValues(header);
  if (values.length !== 1 || !values[0]) return false;
  try {
    const decoded = decodeURIComponent(values[0]);
    const at = decoded.lastIndexOf(".");
    if (at < 1 || decoded.length > 256) return false;
    const token = decoded.slice(0, at);
    const signature = decoded.slice(at + 1);
    return constantTimeEqual(signature, await makeSignature(token, secret));
  } catch {
    return false;
  }
}
