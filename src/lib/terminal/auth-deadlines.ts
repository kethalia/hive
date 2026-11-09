// Bound session authentication and transport setup without extending signed
// ticket or session expiry.
export const TERMINAL_AUTH_SERVER_TIMEOUT_MS = 20_000;
export const TERMINAL_AUTH_CLIENT_TIMEOUT_MS = 25_000;
export const TERMINAL_RELAY_SETUP_TIMEOUT_MS = 30_000;
export const TERMINAL_RELAY_CLIENT_TIMEOUT_MS = TERMINAL_RELAY_SETUP_TIMEOUT_MS + 5_000;
