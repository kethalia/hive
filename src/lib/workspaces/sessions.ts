export interface TmuxSession {
  name: string;
  created: number;
  windows: number;
}

export function parseTmuxSessions(stdout: string): TmuxSession[] {
  if (!stdout.trim()) return [];

  const sessions: TmuxSession[] = [];
  for (const line of stdout.trim().split("\n")) {
    const parts = line.split(":");
    if (parts.length < 3) continue;

    const name = parts[0];
    const created = Number.parseInt(parts[1], 10);
    const windows = Number.parseInt(parts[2], 10);

    if (!name || Number.isNaN(created) || Number.isNaN(windows)) continue;

    sessions.push({ name, created, windows });
  }
  return sessions;
}
