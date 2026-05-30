export const dynamic = "force-dynamic";

import { listTasks } from "@/lib/api/tasks";
import { TaskListContent } from "./task-list-content";
import { TaskListPoller } from "./task-list-poller";

export default async function TasksPage() {
  const taskList = await listTasks();

  return (
    <TaskListPoller>
      <TaskListContent taskList={taskList} />
    </TaskListPoller>
  );
}
