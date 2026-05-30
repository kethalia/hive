import { PlusCircle } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  CardStack,
  ListCard,
  ListCardHeader,
  ListCardMeta,
  ListCardMetaBadge,
  ListCardRow,
  ListCardRows,
  ListCardTitle,
} from "@/components/ui/list-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatRelativeDate, shortRepo, statusVariant } from "@/lib/helpers/format";

interface TaskListItem {
  id: string;
  prompt: string;
  repoUrl: string;
  status: string;
  createdAt: Date | string;
}

interface TaskListContentProps {
  taskList: TaskListItem[];
}

function truncatePrompt(prompt: string, maxLength = 80): string {
  return prompt.length > maxLength ? `${prompt.slice(0, maxLength)}…` : prompt;
}

export function TaskListContent({ taskList }: TaskListContentProps) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
        <Button render={<Link href="/tasks/new" />}>
          <PlusCircle className="mr-2 h-4 w-4" />
          New Task
        </Button>
      </div>

      {/* Empty state */}
      {taskList.length === 0 ? (
        <Card data-testid="tasks-empty-state">
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
        <>
          <CardStack aria-label="Tasks" data-testid="tasks-mobile-card-stack">
            {taskList.map((task) => (
              <ListCard key={task.id} data-testid="task-mobile-card">
                <ListCardHeader>
                  <ListCardTitle>
                    <Link
                      href={`/tasks/${task.id}`}
                      className="flex min-h-11 items-center break-words text-foreground hover:underline"
                    >
                      {truncatePrompt(task.prompt, 120)}
                    </Link>
                  </ListCardTitle>
                  <ListCardMeta>
                    <ListCardMetaBadge variant={statusVariant[task.status] ?? "secondary"}>
                      {task.status}
                    </ListCardMetaBadge>
                    <span>{formatRelativeDate(task.createdAt)}</span>
                  </ListCardMeta>
                </ListCardHeader>
                <ListCardRows>
                  <ListCardRow label="Repository">
                    <code className="text-muted-foreground text-xs">{shortRepo(task.repoUrl)}</code>
                  </ListCardRow>
                </ListCardRows>
              </ListCard>
            ))}
          </CardStack>

          <Card className="hidden md:block" data-testid="tasks-desktop-table">
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
                      <Link href={`/tasks/${task.id}`} className="text-foreground hover:underline">
                        {truncatePrompt(task.prompt)}
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
        </>
      )}
    </div>
  );
}
