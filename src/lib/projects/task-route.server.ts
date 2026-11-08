import { ZodError } from "zod";
import {
  authorizeSessionOwner,
  boundedSessionJson,
  sessionError,
  sessionResponseHeaders,
} from "@/lib/codex-session/route.server";
import { DeliveryConflict } from "@/lib/delivery/state";
import { ProjectDiscoveryError } from "./errors";
import {
  ProjectTaskConflict,
  readProjectTask,
  retryProjectTask,
  startProjectTask,
  type TaskRecoveryStage,
  type TaskStartStage,
} from "./task.server";
import { TaskIntentConflict } from "./task-intents.server";

export function projectTaskRoute(operation: "start" | "status" | "retry") {
  return async (request: Request, { params }: { params: Promise<{ projectId: string }> }) => {
    if (process.env.HIVE_PROJECT_TASKS_ENABLED !== "true")
      return sessionError("tasks_disabled", 404);
    let stage: TaskStartStage | TaskRecoveryStage | "route" = "route";
    let ownerAuthorized = false;
    try {
      const session = await authorizeSessionOwner(request);
      if (session instanceof Response) return session;
      ownerAuthorized = true;
      if (new URL(request.url).search) return sessionError("invalid_request", 400);
      let body: unknown;
      try {
        body = await boundedSessionJson(request, operation === "start" ? 200000 : 4096);
      } catch {
        return sessionError("invalid_request", 400);
      }
      const { projectId } = await params;
      const result =
        operation === "start"
          ? await startProjectTask(session.user, projectId, body, (next) => {
              stage = next;
            })
          : operation === "retry"
            ? await retryProjectTask(session.user, projectId, body, (next) => {
                stage = next;
              })
            : await readProjectTask(session.user, projectId, body);
      return Response.json(result, {
        headers: sessionResponseHeaders,
      });
    } catch (error) {
      let code = "task_unavailable";
      let category = "internal";
      let statusCode = 503;
      if (error instanceof ZodError) {
        code = "invalid_request";
        category = "validation";
        statusCode = 400;
      } else if (error instanceof TaskIntentConflict) {
        code = "task_identity_conflict";
        category = "intent_conflict";
        statusCode = 409;
      } else if (error instanceof ProjectTaskConflict) {
        code = "source_changed";
        category = "source_conflict";
        statusCode = 409;
      } else if (
        error instanceof DeliveryConflict &&
        [
          "repository_policy_not_enrolled",
          "repository_policy_ref_resolution_pending",
          "repository_policy_revoked",
          "repository_policy_disabled",
          "repository_policy_selection_changed",
          "repository_policy_source_changed",
          "repository_policy_intent_unbound",
          "repository_policy_identity_changed",
          "repository_policy_enrollment_revoked",
        ].includes(error.code)
      ) {
        code = error.code;
        category = "policy_conflict";
        statusCode = 409;
      } else if (error instanceof ProjectDiscoveryError) {
        code = error.code;
        category = "discovery";
        statusCode = ["workspace_forbidden", "github_permission_denied"].includes(error.code)
          ? 403
          : 502;
      }
      if (operation === "start")
        console.error("project_task_start_failed", { stage, category, statusCode });
      if (operation === "retry" && ownerAuthorized) {
        console.error("project_task_retry_failed", { stage, category, statusCode });
        return Response.json(
          { error: code, failureStage: stage },
          { status: statusCode, headers: sessionResponseHeaders },
        );
      }
      return sessionError(code, statusCode);
    }
  };
}
