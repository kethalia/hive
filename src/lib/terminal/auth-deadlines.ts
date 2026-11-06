// Refresh is serialized for at most 15s. Allow transport overhead without
// extending the lifetime or authority of the terminal ticket being issued.
export const TERMINAL_AUTH_SERVER_TIMEOUT_MS = 20_000;
export const TERMINAL_AUTH_CLIENT_TIMEOUT_MS = 25_000;
