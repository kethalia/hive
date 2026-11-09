/** OAuth grants use RFC 6750; managed and legacy Coder keys retain their header. */
export function coderCredentialHeaders(token: string, source?: string): Record<string, string> {
  return source === "oauth"
    ? { Authorization: `Bearer ${token}` }
    : { "Coder-Session-Token": token };
}
