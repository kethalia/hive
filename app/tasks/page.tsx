import Link from "next/link";
import { listTasks } from "@/lib/api/tasks";
import { TaskListPoller } from "./task-list-poller";

/** Map task status to Tailwind badge classes */
const statusStyles: Record<string, string> = {
  queued: "bg-blue-900/50 text-blue-300 ring-1 ring-blue-500/30",
  running: "bg-yellow-900/50 text-yellow-300 ring-1 ring-yellow-500/30",
  verifying: "bg-purple-900/50 text-purple-300 ring-1 ring-purple-500/30",
  done: "bg-green-900/50 text-green-300 ring-1 ring-green-500/30",
  failed: "bg-red-900/50 text-red-300 ring-1 ring-red-500/30",
};

/** Extract org/repo from a GitHub URL */
function shortRepo(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return url;
  } catch {
    return url;
  }
}

/** Format a date as relative or short string */
function formatDate(date: Date | string): string {
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

export default async function TasksPage() {
  const taskList = await listTasks();

  return (
    <TaskListPoller>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">Tasks</h1>
          <Link
            href="/tasks/new"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-950"
          >
            + New Task
          </Link>
        </div>

        {/* Empty state */}
        {taskList.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-12 text-center">
            <p className="text-gray-400 text-lg">No tasks yet.</p>
            <p className="text-gray-500 mt-1">
              <Link href="/tasks/new" className="text-blue-400 hover:text-blue-300 underline">
                Create your first task
              </Link>{" "}
              to get started.
            </p>
          </div>
        ) : (
          /* Task table */
          <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Prompt</th>
                  <th className="px-4 py-3 font-medium">Repository</th>
                  <th className="px-4 py-3 font-medium text-right">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {taskList.map((task) => (
                  <tr key={task.id} className="hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          statusStyles[task.status] ?? "bg-gray-800 text-gray-400"
                        }`}
                      >
                        {task.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/tasks/${task.id}`}
                        className="text-gray-200 hover:text-white hover:underline"
                      >
                        {task.prompt.length > 80
                          ? task.prompt.slice(0, 80) + "…"
                          : task.prompt}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-gray-400 font-mono text-xs">
                        {shortRepo(task.repoUrl)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500 text-xs">
                      {formatDate(task.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </TaskListPoller>
  );
}
