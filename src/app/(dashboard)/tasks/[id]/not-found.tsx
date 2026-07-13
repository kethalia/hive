import { ArrowLeft, PlusCircle, SearchX } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function TaskNotFound() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto p-4">
      <Card className="w-full max-w-xl">
        <CardContent className="flex flex-col items-start py-8 sm:py-10">
          <SearchX className="size-8 text-primary" aria-hidden="true" />
          <p className="mt-6 text-xs uppercase tracking-[0.18em] text-primary">Task lookup / 404</p>
          <h1 className="mt-2 text-2xl font-medium">This task is no longer available.</h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            The link may be stale, the task may have been removed, or it may belong to another Hive
            session.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button nativeButton={false} render={<Link href="/tasks" />} variant="outline">
              <ArrowLeft className="size-4" aria-hidden="true" /> Tasks
            </Button>
            <Button nativeButton={false} render={<Link href="/tasks/new" />}>
              <PlusCircle className="size-4" aria-hidden="true" /> New task
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
