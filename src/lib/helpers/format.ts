// ── Shared formatting and display helpers ──────────────────────────

/** Extract org/repo from a GitHub URL. */
export function shortRepo(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return url;
  } catch {
    return url;
  }
}

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

/** Format a date as a short timestamp (e.g. "Mar 19, 10:30:45 AM"). */
export function formatTimestamp(date: string): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Truncate a UUID to 8 chars. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Read a File as a base64-encoded string (without the data URL prefix). */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ── Badge variant mapping ──────────────────────────────────────────

/** Map task/workspace status to shadcn Badge variant. */
export const statusVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "secondary",
  running: "default",
  verifying: "outline",
  done: "default",
  failed: "destructive",
  pending: "secondary",
  starting: "secondary",
  stopped: "outline",
  deleted: "outline",
};
