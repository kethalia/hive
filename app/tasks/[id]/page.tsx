import { notFound } from "next/navigation";
import { getTask } from "@/lib/api/tasks";
import { TaskDetail } from "./task-detail";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const task = await getTask(id);

  if (!task) {
    notFound();
  }

  // Serialize Date objects to ISO strings for the client component
  const serialized = JSON.parse(JSON.stringify(task));

  return <TaskDetail initialTask={serialized} />;
}
