import Link from "next/link";
import { listTasks } from "@/lib/api/tasks";
import { TaskListPoller } from "./task-list-poller";
import { shortRepo, formatRelativeDate, statusVariant } from "@/lib/helpers/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PlusCircle } from "lucide-react";

export default async function TasksPage() {
  const taskList = await listTasks();

  return (
    <TaskListPoller>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
          <Button render={<Link href="/tasks/new" />}>
            <PlusCircle className="mr-2 h-4 w-4" />
            New Task
          </Button>
        </div>

        {/* Empty state */}
        {taskList.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-muted-foreground text-lg">No tasks yet.</p>
              <p className="text-muted-foreground mt-1 text-sm">
                <Link href="/tasks/new" className="text-primary underline hover:no-underline">
                  Create your first task
                </Link>{" "}
                to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead>Prompt</TableHead>
                  <TableHead>Repository</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {taskList.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell>
                      <Badge variant={statusVariant[task.status] ?? "secondary"}>
                        {task.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/tasks/${task.id}`}
                        className="text-foreground hover:underline"
                      >
                        {task.prompt.length > 80
                          ? task.prompt.slice(0, 80) + "…"
                          : task.prompt}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <code className="text-muted-foreground text-xs">
                        {shortRepo(task.repoUrl)}
                      </code>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs">
                      {formatRelativeDate(task.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
    </TaskListPoller>
  );
}
