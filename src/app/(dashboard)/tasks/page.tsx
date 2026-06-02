export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { listTasks } from "@/lib/api/tasks";
import { getRequestSession } from "@/lib/auth/session";
import { TaskListContent } from "./task-list-content";
import { TaskListPoller } from "./task-list-poller";

export default async function TasksPage() {
  const session = await getRequestSession();
  if (!session) {
    redirect("/login");
  }

  const taskList = await listTasks(session.user.id);

  return (
    <TaskListPoller>
      <TaskListContent taskList={taskList} />
    </TaskListPoller>
  );
}
