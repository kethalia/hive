import { notFound, redirect } from "next/navigation";
import { getTask } from "@/lib/api/tasks";
import { getSession } from "@/lib/auth/session";
import { TaskDetail } from "./task-detail";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  const { id } = await params;
  const task = await getTask(id, session.userId);

  if (!task) {
    notFound();
  }

  // Serialize Date objects to ISO strings for the client component
  const serialized = JSON.parse(JSON.stringify(task));

  return <TaskDetail initialTask={serialized} />;
}
