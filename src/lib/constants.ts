// ── Shared constants — single source of truth ─────────────────────
//
// Import from here instead of re-declaring in each file.
// Grouped by domain for easy scanning.

// ── Timeouts ───────────────────────────────────────────────────────

/** Default workspace exec timeout (60s). */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

// ── Token lifecycle ───────────────────────────────────────────────

/** Fraction of lifetime elapsed before triggering rotation. */
export const TOKEN_ROTATION_THRESHOLD = 0.75;

/** BullMQ queue name for token rotation jobs. */
export const TOKEN_ROTATION_QUEUE = "token-rotation";

// ── Push notifications ────────────────────────────────────────────

/** Hours before token expiry to fire a push notification. */
export const PUSH_NOTIFICATION_HOURS = 24;

/** Notification tag for dedup — only one active notification per tag. */
export const PUSH_NOTIFICATION_TAG = "token-expiry";

// ── Dashboard ──────────────────────────────────────────────────────

/** Polling interval for workspace and template status refreshes (5s). */
export const POLL_INTERVAL_MS = 5_000;

// ── Validation ─────────────────────────────────────────────────────

// Keep in sync with services/terminal-proxy/src/protocol.ts SAFE_IDENTIFIER_RE
export const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9._-]+$/;

/** UUID v4 format regex. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── SSE stream polling ────────────────────────────────────────────

/** Polling interval for SSE log file tailing (500ms). */
export const SSE_POLL_INTERVAL_MS = 500;

/** Max time to wait for a log file to appear before giving up (30s). */
export const SSE_LOG_WAIT_TIMEOUT_MS = 30_000;

/** Max poll iterations before timing out SSE stream (240 × 500ms = 120s). */
export const SSE_MAX_POLLS = 240;

// ── Defaults ───────────────────────────────────────────────────────
