// ── Shared constants — single source of truth ─────────────────────
//
// Import from here instead of re-declaring in each file.
// Grouped by domain for easy scanning.

// ── Workspace paths ────────────────────────────────────────────────

/** The project directory inside Coder workspaces. */
export const PROJECT_DIR = "/home/coder/project";

// ── Temp file paths (inside workspaces) ────────────────────────────

/** Agent output log — written by tee, tailed by SSE route. */
export const AGENT_OUTPUT_LOG = "/tmp/hive-agent-output.log";

/** Assembled context file piped to the agent via base64. */
export const CONTEXT_FILE = "/tmp/hive-context.md";

/** Prompt file piped to the agent via base64. */
export const PROMPT_FILE = "/tmp/hive-prompt.txt";

/** Commit message file used by git commit -F. */
export const COMMIT_MSG_FILE = "/tmp/hive-commit-msg.txt";

// ── Timeouts ───────────────────────────────────────────────────────

/** Default timeout for exec commands in blueprint steps (30s). */
export const EXEC_TIMEOUT_MS = 30_000;

/** Agent execution timeout (30 minutes). */
export const AGENT_TIMEOUT_MS = 1_800_000;

/** Lint step hard timeout (5 seconds). */
export const LINT_TIMEOUT_MS = 5_000;

/** PR creation timeout (30s). */
export const PR_TIMEOUT_MS = 30_000;

/** Git operations timeout (30s). */
export const GIT_TIMEOUT_MS = 30_000;

/** Default workspace exec timeout (60s). */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/** BullMQ job timeout — 90 minutes to accommodate CI polling + agent retry. */
export const JOB_TIMEOUT_MS = 90 * 60 * 1_000;

/** Test execution timeout in verifier (2 minutes). */
export const TEST_TIMEOUT_MS = 120_000;

/** Dev server start timeout in verifier (90s). */
export const SERVER_TIMEOUT_MS = 90_000;

// ── CI feedback constants ──────────────────────────────────────────

/** Delay before first CI poll to let the run register (10s). */
export const CI_INITIAL_DELAY_MS = 10_000;

/** Total timeout for CI polling (10 minutes). */
export const CI_POLL_TIMEOUT_MS = 600_000;

/** Exponential backoff intervals for CI polling. */
export const CI_BACKOFF_INTERVALS_MS = [5_000, 10_000, 20_000, 30_000];

/** Max chars of failure logs to extract from CI. */
export const CI_MAX_FAILURE_LOG_CHARS = 3_000;

/** Timeout for individual gh CLI commands (30s). */
export const GH_CMD_TIMEOUT_MS = 30_000;

/** Maximum CI retry rounds before flagging for human review. */
export const CI_MAX_ROUNDS = 2;

// ── Queue ──────────────────────────────────────────────────────────

/** BullMQ queue name for task dispatch. */
export const QUEUE_NAME = "task-dispatch";

// ── Dashboard ──────────────────────────────────────────────────────

/** Polling interval for task list and detail pages (5s). */
export const POLL_INTERVAL_MS = 5_000;

/** Max lines to keep in the streaming panel before truncating. */
export const MAX_STREAM_LINES = 5_000;

// ── Blueprint tools ────────────────────────────────────────────────

/** Base tools available to all agents regardless of repo type. */
export const BASE_TOOLS = ["read", "bash", "edit", "write", "lsp"];

/** Web frameworks that trigger browser tool inclusion. */
export const WEB_FRAMEWORKS = ["next", "react", "vue", "svelte", "nuxt", "remix", "astro"];

/** Test frameworks that trigger test tool inclusion. */
export const TEST_FRAMEWORKS = ["vitest", "jest", "playwright", "cypress", "mocha"];

/** Key files fetched during context hydration. */
export const HYDRATION_KEY_FILES = [
  "README.md",
  "package.json",
  "tsconfig.json",
  "AGENTS.md",
  "CODEOWNERS",
];

// ── Verifier ───────────────────────────────────────────────────────

/** npm's default "no test specified" script — excluded from detection. */
export const DEFAULT_TEST_SCRIPT = 'echo "Error: no test specified" && exit 1';

/** Curl retry command for web-app verification. */
export const CURL_RETRY_CMD =
  "curl --retry 12 --retry-delay 5 --retry-all-errors -sf http://localhost:3000 > /dev/null";

/** Screenshot command for web-app verification. */
export const SCREENSHOT_CMD = "browser-screenshot http://localhost:3000 /tmp/verification.png";

// ── Validation ─────────────────────────────────────────────────────

/** Regex for values safe to interpolate into shell commands. */
export const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9._-]+$/;

/** UUID v4 format regex. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Defaults ───────────────────────────────────────────────────────

/** Default worker concurrency for BullMQ. */
export const DEFAULT_WORKER_CONCURRENCY = 5;

/** Default cleanup grace period in milliseconds. */
export const DEFAULT_CLEANUP_GRACE_MS = 60_000;

/** Default Pi LLM provider. */
export const DEFAULT_PI_PROVIDER = "anthropic";

/** Default Pi LLM model. */
export const DEFAULT_PI_MODEL = "claude-sonnet-4-20250514";
