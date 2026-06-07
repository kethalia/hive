export type WorkspacePaneConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "failed"
  | "workspace-offline";

export type WorkspacePaneRecoveryPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "recovering"
  | "workspace-offline"
  | "final-failure";

export type WorkspacePaneCloseCategory =
  | "transient"
  | "workspace-offline"
  | "auth-expired"
  | "permission-denied"
  | "clone-proof-invalid"
  | "terminal-closed"
  | "unknown-final-failure";

export type WorkspacePaneCloseReasonCategory =
  | "none"
  | "auth-expired"
  | "permission-denied"
  | "clone-proof-invalid"
  | "workspace-offline"
  | "upstream-timeout"
  | "upstream-error"
  | "timeout"
  | "unknown";

export type WorkspacePaneRecoveryFailureCategory =
  | "auth-expired"
  | "permission-denied"
  | "clone-proof-invalid"
  | "terminal-closed"
  | "unknown-final-failure";

export type WorkspacePaneRefreshAction =
  | "none"
  | "refresh-before-reconnect"
  | "refresh-succeeded"
  | "refresh-failed";

export type WorkspacePaneRefreshFailureCategory =
  | "callback-error"
  | "malformed-response"
  | "malformed-identity"
  | "session-name-mismatch";

export type WorkspacePaneRecoveryAction =
  | "none"
  | "initial-connect"
  | "schedule-reconnect"
  | "manual-reconnect"
  | "connected";

export interface WorkspacePaneTerminalRecoveryInput {
  phase?: WorkspacePaneRecoveryPhase | string | null;
  retryCount?: number | null;
  lastCloseCategory?: WorkspacePaneCloseCategory | string | null;
  lastReasonCategory?: WorkspacePaneCloseReasonCategory | string | null;
  failureCategory?: WorkspacePaneRecoveryFailureCategory | string | null;
  lastRecoveryAction?: WorkspacePaneRecoveryAction | string | null;
  lastRefreshAction?: WorkspacePaneRefreshAction | string | null;
  refreshFailureCategory?: WorkspacePaneRefreshFailureCategory | string | null;
  isRecoverable?: boolean | null;
}

export type WorkspaceGitRefreshStatus = "idle" | "refreshing" | "succeeded" | "failed";

export interface WorkspaceGitPaneRefreshInput {
  status?: WorkspaceGitRefreshStatus | string | null;
  failureCategory?: WorkspacePaneRefreshFailureCategory | string | null;
}

export type WorkspaceKeepAliveStatus = "healthy" | "failing" | "no-token" | "recently-disconnected";

export type WorkspaceKeepAliveFailureCategory =
  | "http-auth"
  | "http-client"
  | "http-server"
  | "timeout"
  | "network"
  | "unknown";

export interface WorkspaceKeepAliveInput {
  status?: WorkspaceKeepAliveStatus | string | null;
  consecutiveFailures?: number | null;
  lastFailureCategory?: WorkspaceKeepAliveFailureCategory | string | null;
  activeConnectionCount?: number | null;
}

export interface WorkspacePaneRecoveryInput {
  boardPaneKey: string;
  kind?: "terminal" | "git" | string | null;
  connectionState?: WorkspacePaneConnectionState | string | null;
  recoveryState?: WorkspacePaneTerminalRecoveryInput | null;
  gitRefreshState?: WorkspaceGitPaneRefreshInput | null;
}

export type WorkspaceRecoverySeverity = "info" | "warning" | "critical";
export type WorkspaceRecoveryPhase = "degraded" | "recovering" | "workspace-offline" | "failed";
export type WorkspaceRecoveryCategory =
  | `terminal:${WorkspacePaneCloseReasonCategory | WorkspacePaneCloseCategory | WorkspacePaneRecoveryFailureCategory}`
  | `git-refresh:${WorkspacePaneRefreshFailureCategory | "unknown"}`
  | `keepalive:${WorkspaceKeepAliveFailureCategory | "recently-disconnected" | "high-failures" | "unknown"}`;

export interface WorkspacePaneRecoveryAggregate {
  paneCount: number;
  unhealthyPaneCount: number;
  severity: WorkspaceRecoverySeverity;
  phase: WorkspaceRecoveryPhase;
  categories: WorkspaceRecoveryCategory[];
  message: string;
  dataAttributes: Record<string, string>;
}

export interface SummarizeWorkspacePaneRecoveryInput {
  visibleBoardPaneKeys: readonly string[];
  panes:
    | readonly WorkspacePaneRecoveryInput[]
    | Record<string, WorkspacePaneRecoveryInput | null | undefined>;
  keepalive?: WorkspaceKeepAliveInput | null;
  highConsecutiveKeepaliveFailures?: number;
}

interface PaneFinding {
  severity: WorkspaceRecoverySeverity;
  phase: WorkspaceRecoveryPhase;
  categories: WorkspaceRecoveryCategory[];
}

const DEFAULT_HIGH_KEEPALIVE_FAILURES = 3;
const SEVERITY_WEIGHT: Record<WorkspaceRecoverySeverity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};
const PHASE_WEIGHT: Record<WorkspaceRecoveryPhase, number> = {
  degraded: 1,
  recovering: 2,
  "workspace-offline": 3,
  failed: 4,
};

const TERMINAL_REASON_CATEGORIES = new Set<WorkspacePaneCloseReasonCategory>([
  "none",
  "auth-expired",
  "permission-denied",
  "clone-proof-invalid",
  "workspace-offline",
  "upstream-timeout",
  "upstream-error",
  "timeout",
  "unknown",
]);
const TERMINAL_CLOSE_CATEGORIES = new Set<WorkspacePaneCloseCategory>([
  "transient",
  "workspace-offline",
  "auth-expired",
  "permission-denied",
  "clone-proof-invalid",
  "terminal-closed",
  "unknown-final-failure",
]);
const TERMINAL_FAILURE_CATEGORIES = new Set<WorkspacePaneRecoveryFailureCategory>([
  "auth-expired",
  "permission-denied",
  "clone-proof-invalid",
  "terminal-closed",
  "unknown-final-failure",
]);
const REFRESH_FAILURE_CATEGORIES = new Set<WorkspacePaneRefreshFailureCategory>([
  "callback-error",
  "malformed-response",
  "malformed-identity",
  "session-name-mismatch",
]);
const KEEPALIVE_FAILURE_CATEGORIES = new Set<WorkspaceKeepAliveFailureCategory>([
  "http-auth",
  "http-client",
  "http-server",
  "timeout",
  "network",
  "unknown",
]);

export function summarizeWorkspacePaneRecovery({
  visibleBoardPaneKeys,
  panes,
  keepalive,
  highConsecutiveKeepaliveFailures = DEFAULT_HIGH_KEEPALIVE_FAILURES,
}: SummarizeWorkspacePaneRecoveryInput): WorkspacePaneRecoveryAggregate | null {
  const visibleKeys = normalizeVisibleKeys(visibleBoardPaneKeys);
  if (visibleKeys.length === 0) return null;

  const paneMap = normalizePaneMap(panes);
  const findings: PaneFinding[] = [];
  let unhealthyPaneCount = 0;

  for (const key of visibleKeys) {
    const pane = paneMap.get(key);
    if (!pane) continue;
    const finding = summarizePane(pane);
    if (!finding) continue;
    unhealthyPaneCount += 1;
    findings.push(finding);
  }

  const keepaliveFinding = summarizeKeepalive(keepalive, highConsecutiveKeepaliveFailures);
  if (keepaliveFinding) findings.push(keepaliveFinding);

  if (findings.length === 0) return null;

  const severity = highestByWeight(
    findings.map((finding) => finding.severity),
    SEVERITY_WEIGHT,
  );
  const phase = highestByWeight(
    findings.map((finding) => finding.phase),
    PHASE_WEIGHT,
  );
  const categories = uniqueSortedCategories(findings.flatMap((finding) => finding.categories));
  const paneCount = visibleKeys.length;
  const message = buildMessage({
    paneCount,
    unhealthyPaneCount,
    phase,
    hasKeepalive: Boolean(keepaliveFinding),
  });

  return {
    paneCount,
    unhealthyPaneCount,
    severity,
    phase,
    categories,
    message,
    dataAttributes: {
      "data-workspace-recovery-status": "unhealthy",
      "data-workspace-recovery-pane-count": String(paneCount),
      "data-workspace-recovery-unhealthy-pane-count": String(unhealthyPaneCount),
      "data-workspace-recovery-severity": severity,
      "data-workspace-recovery-phase": phase,
      "data-workspace-recovery-categories": categories.join(" "),
    },
  };
}

function normalizeVisibleKeys(keys: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const normalized = typeof key === "string" ? key.trim() : "";
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizePaneMap(
  panes:
    | readonly WorkspacePaneRecoveryInput[]
    | Record<string, WorkspacePaneRecoveryInput | null | undefined>,
): Map<string, WorkspacePaneRecoveryInput> {
  const map = new Map<string, WorkspacePaneRecoveryInput>();
  if (Array.isArray(panes)) {
    for (const pane of panes) {
      if (!pane || typeof pane.boardPaneKey !== "string") continue;
      const key = pane.boardPaneKey.trim();
      if (key) map.set(key, pane);
    }
    return map;
  }

  for (const [key, pane] of Object.entries(panes ?? {})) {
    if (!pane) continue;
    const paneKey =
      typeof pane.boardPaneKey === "string" && pane.boardPaneKey.trim()
        ? pane.boardPaneKey.trim()
        : key.trim();
    if (paneKey) map.set(paneKey, { ...pane, boardPaneKey: paneKey });
  }
  return map;
}

function summarizePane(pane: WorkspacePaneRecoveryInput): PaneFinding | null {
  const terminalFinding = summarizeTerminalPane(pane);
  const gitFinding = summarizeGitPane(pane.gitRefreshState);
  if (!terminalFinding) return gitFinding;
  if (!gitFinding) return terminalFinding;

  return {
    severity: maxSeverity(terminalFinding.severity, gitFinding.severity),
    phase: maxPhase(terminalFinding.phase, gitFinding.phase),
    categories: [...terminalFinding.categories, ...gitFinding.categories],
  };
}

function summarizeTerminalPane(pane: WorkspacePaneRecoveryInput): PaneFinding | null {
  const state = pane.connectionState;
  const recovery = pane.recoveryState ?? undefined;
  const phase = recovery?.phase;

  if (state === "failed" || phase === "final-failure" || recovery?.isRecoverable === false) {
    return {
      severity: "critical",
      phase: "failed",
      categories: [
        terminalCategory(
          recovery?.failureCategory,
          recovery?.lastCloseCategory,
          recovery?.lastReasonCategory,
        ),
      ],
    };
  }

  if (state === "workspace-offline" || phase === "workspace-offline") {
    return {
      severity: "critical",
      phase: "workspace-offline",
      categories: ["terminal:workspace-offline"],
    };
  }

  if (
    state === "reconnecting" ||
    state === "disconnected" ||
    phase === "recovering" ||
    recovery?.lastRecoveryAction === "schedule-reconnect"
  ) {
    return {
      severity: "warning",
      phase: "recovering",
      categories: [
        terminalCategory(
          recovery?.failureCategory,
          recovery?.lastCloseCategory,
          recovery?.lastReasonCategory,
        ),
      ],
    };
  }

  if (state === "connecting" || phase === "connecting") {
    return {
      severity: "info",
      phase: "degraded",
      categories: ["terminal:transient"],
    };
  }

  if (recovery?.lastRefreshAction === "refresh-failed" || recovery?.refreshFailureCategory) {
    return {
      severity: "warning",
      phase: "recovering",
      categories: [gitRefreshCategory(recovery.refreshFailureCategory)],
    };
  }

  return null;
}

function summarizeGitPane(
  gitRefreshState?: WorkspaceGitPaneRefreshInput | null,
): PaneFinding | null {
  if (!gitRefreshState) return null;
  if (gitRefreshState.status === "failed" || gitRefreshState.failureCategory) {
    return {
      severity: "warning",
      phase: "recovering",
      categories: [gitRefreshCategory(gitRefreshState.failureCategory)],
    };
  }
  return null;
}

function summarizeKeepalive(
  keepalive: WorkspaceKeepAliveInput | null | undefined,
  highConsecutiveKeepaliveFailures: number,
): PaneFinding | null {
  if (!keepalive) return null;
  const failures = normalizeCount(keepalive.consecutiveFailures);
  const threshold = Math.max(1, Math.trunc(highConsecutiveKeepaliveFailures));

  if (failures >= threshold) {
    return {
      severity: "critical",
      phase: "degraded",
      categories: ["keepalive:high-failures"],
    };
  }

  if (keepalive.status === "failing") {
    return {
      severity: "warning",
      phase: "degraded",
      categories: [keepaliveCategory(keepalive.lastFailureCategory)],
    };
  }

  if (keepalive.status === "recently-disconnected") {
    return {
      severity: "warning",
      phase: "degraded",
      categories: ["keepalive:recently-disconnected"],
    };
  }

  return null;
}

function terminalCategory(
  failureCategory?: string | null,
  closeCategory?: string | null,
  reasonCategory?: string | null,
): WorkspaceRecoveryCategory {
  if (isInSet(failureCategory, TERMINAL_FAILURE_CATEGORIES)) return `terminal:${failureCategory}`;
  if (isInSet(reasonCategory, TERMINAL_REASON_CATEGORIES) && reasonCategory !== "none") {
    return `terminal:${reasonCategory}`;
  }
  if (isInSet(closeCategory, TERMINAL_CLOSE_CATEGORIES)) return `terminal:${closeCategory}`;
  return "terminal:unknown";
}

function gitRefreshCategory(value?: string | null): WorkspaceRecoveryCategory {
  if (isInSet(value, REFRESH_FAILURE_CATEGORIES)) return `git-refresh:${value}`;
  return "git-refresh:unknown";
}

function keepaliveCategory(value?: string | null): WorkspaceRecoveryCategory {
  if (isInSet(value, KEEPALIVE_FAILURE_CATEGORIES)) return `keepalive:${value}`;
  return "keepalive:unknown";
}

function isInSet<T extends string>(value: string | null | undefined, set: Set<T>): value is T {
  return typeof value === "string" && set.has(value as T);
}

function normalizeCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function uniqueSortedCategories(
  categories: WorkspaceRecoveryCategory[],
): WorkspaceRecoveryCategory[] {
  return [...new Set(categories)].sort();
}

function highestByWeight<T extends string>(values: T[], weights: Record<T, number>): T {
  return values.reduce((highest, value) => (weights[value] > weights[highest] ? value : highest));
}

function maxSeverity(
  left: WorkspaceRecoverySeverity,
  right: WorkspaceRecoverySeverity,
): WorkspaceRecoverySeverity {
  return SEVERITY_WEIGHT[left] >= SEVERITY_WEIGHT[right] ? left : right;
}

function maxPhase(
  left: WorkspaceRecoveryPhase,
  right: WorkspaceRecoveryPhase,
): WorkspaceRecoveryPhase {
  return PHASE_WEIGHT[left] >= PHASE_WEIGHT[right] ? left : right;
}

function buildMessage({
  paneCount,
  unhealthyPaneCount,
  phase,
  hasKeepalive,
}: {
  paneCount: number;
  unhealthyPaneCount: number;
  phase: WorkspaceRecoveryPhase;
  hasKeepalive: boolean;
}): string {
  if (phase === "failed") {
    return `Workspace pane recovery needs attention. ${unhealthyPaneCount} of ${paneCount} visible panes need attention.`;
  }
  if (phase === "workspace-offline") {
    return `Workspace appears offline. ${unhealthyPaneCount} of ${paneCount} visible panes need attention.`;
  }
  if (unhealthyPaneCount > 0) {
    return `Workspace panes are recovering. ${unhealthyPaneCount} of ${paneCount} visible panes need attention.`;
  }
  if (hasKeepalive) return "Workspace keepalive needs attention.";
  return "Workspace recovery status needs attention.";
}
