import { redirect } from "next/navigation";
import { getTask } from "@/lib/api/tasks";
import { getRequestSession } from "@/lib/auth/session";
import { UUID_RE } from "@/lib/constants";
import TaskNotFound from "./not-found";
import { TaskDetail } from "./task-detail";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getRequestSession();
  if (!session) {
    redirect("/login");
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return <TaskNotFound />;
  }
  const task = await getTask(id, session.user.id);

  if (!task) {
    return <TaskNotFound />;
  }

  // Serialize Date objects to ISO strings for the client component
  const serialized = JSON.parse(JSON.stringify(task));

  return <TaskDetail initialTask={serialized} />;
}
