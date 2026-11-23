import { after } from "next/server";
import { ZodError } from "zod";
import {
  authorizeSessionOwner,
  boundedSessionJson,
  sessionError,
  sessionResponseHeaders,
} from "@/lib/codex-session/route.server";
import { ProjectDiscoveryError } from "./errors";
import {
  managedProjectTasksEnabled,
  ProjectTaskConflict,
  readProjectTask,
  reconcileProjectTask,
  requestProjectCleanup,
  retryProjectTask,
  startProjectTask,
} from "./task.server";
import { TaskIntentConflict } from "./task-intents.server";

export function projectTaskRoute(operation: "start" | "status" | "retry" | "cleanup") {
  return async (request: Request, { params }: { params: Promise<{ projectId: string }> }) => {
    if (!managedProjectTasksEnabled()) return sessionError("tasks_disabled", 404);
    try {
      const session = await authorizeSessionOwner(request);
      if (session instanceof Response) return session;
      if (new URL(request.url).search) return sessionError("invalid_request", 400);
      let body: unknown;
      try {
        body = await boundedSessionJson(request, operation === "start" ? 200000 : 4096);
      } catch {
        return sessionError("invalid_request", 400);
      }
      const { projectId } = await params;
      if (operation === "cleanup")
        return Response.json(
          await requestProjectCleanup(session.user, projectId, body, request.signal),
          {
            headers: sessionResponseHeaders,
          },
        );
      const execute =
        operation === "start"
          ? startProjectTask
          : operation === "retry"
            ? retryProjectTask
            : readProjectTask;
      const result = await execute(session.user, projectId, body, request.signal);
      if (result.phase !== "blocked") {
        const target = { ownerId: session.user.id, taskId: result.taskId };
        after(async () => {
          try {
            await reconcileProjectTask(target, AbortSignal.timeout(55_000));
          } catch {
            // An interrupted claim stays durable and becomes eligible after its lease.
            console.error("project_task_reconcile_interrupted");
          }
        });
      }
      return Response.json(result, { headers: sessionResponseHeaders });
    } catch (error) {
      if (error instanceof ZodError) return sessionError("invalid_request", 400);
      if (error instanceof TaskIntentConflict) return sessionError("task_identity_conflict", 409);
      if (error instanceof ProjectTaskConflict) return sessionError("source_changed", 409);
      if (error instanceof ProjectDiscoveryError)
        return sessionError(
          error.code,
          ["workspace_forbidden", "github_permission_denied"].includes(error.code) ? 403 : 502,
        );
      return sessionError("task_unavailable", 503);
    }
  };
}
