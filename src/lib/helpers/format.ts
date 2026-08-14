// ── Shared formatting and display helpers ──────────────────────────

/** Format a date as relative or short string. */
export function formatRelativeDate(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Badge variant mapping ──────────────────────────────────────────

/** Map Coder workspace status to shadcn Badge variant. */
export const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  starting: "secondary",
  running: "default",
  stopping: "secondary",
  stopped: "outline",
  deleting: "secondary",
  deleted: "outline",
  canceling: "secondary",
  canceled: "outline",
  failed: "destructive",
};
