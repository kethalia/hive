import { boundedSessionJson } from "@/lib/codex-session/route.server";
import {
  authorizeProjectReconcile,
  projectReconcileDeadline,
  projectReconcileFailure,
} from "./reconcile-transport";
import { reconcileProjectTasks } from "./task.server";

export async function projectReconcileRoute(request: Request) {
  const rejected = authorizeProjectReconcile(request, process.env);
  if (rejected) return projectReconcileFailure(rejected);
  const deadline = projectReconcileDeadline(request);
  if (deadline === null) return projectReconcileFailure(400);
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  ]);
  let body: unknown;
  try {
    signal.throwIfAborted();
    body = await boundedSessionJson(request, 512);
  } catch {
    return projectReconcileFailure(signal.aborted ? 408 : 400);
  }
  try {
    signal.throwIfAborted();
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).join() !== "schemaVersion" ||
      !("schemaVersion" in body) ||
      body.schemaVersion !== 1
    )
      return projectReconcileFailure(400);
    const result = await reconcileProjectTasks(undefined, 1, { signal });
    signal.throwIfAborted();
    if (!result.enabled) return projectReconcileFailure(404);
    return Response.json(
      { schemaVersion: 1, processed: result.processed, retry: result.retry, stale: result.stale },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return projectReconcileFailure(signal.aborted ? 408 : 503);
  }
}
