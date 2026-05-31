import { z } from "zod";

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
];

function validateCoderUrl(raw: string): string {
  const url = new URL(raw);

  const allowlist = process.env.ALLOWED_CODER_URLS;
  if (allowlist) {
    const allowed = allowlist.split(",").map((u) => u.trim().replace(/\/+$/, ""));
    const normalized = `${url.protocol}//${url.host}`;
    if (!allowed.includes(normalized)) {
      throw new Error("Coder URL is not in the allowed list");
    }
    return raw;
  }

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("Coder URL must use HTTPS in production");
  }

  const hostname = url.hostname;
  if (hostname === "localhost" && process.env.NODE_ENV === "production") {
    throw new Error("Coder URL cannot target localhost in production");
  }
  if (PRIVATE_IP_PATTERNS.some((re) => re.test(hostname))) {
    throw new Error("Coder URL cannot target private or reserved IP ranges");
  }

  return raw;
}

export const loginSchema = z.object({
  coderUrl: z.string().url().transform(validateCoderUrl),
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginInput = z.infer<typeof loginSchema>;

export function getClientIp(headerStore: { get(name: string): string | null }): string {
  return (
    headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headerStore.get("x-real-ip") ??
    "unknown"
  );
}
