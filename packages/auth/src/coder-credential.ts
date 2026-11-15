export type CoderCredentialSource = "legacy" | "oauth";

export function coderCredentialHeaders(
  token: string,
  source?: CoderCredentialSource,
): Record<string, string> {
  return source === "oauth"
    ? { Authorization: `Bearer ${token}` }
    : { "Coder-Session-Token": token };
}
