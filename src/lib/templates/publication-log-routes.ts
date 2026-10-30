import type { SessionData } from "@hive/auth";
import { z } from "zod";
import { publicationNameSchema, TemplatePublicationError } from "./publication-contracts";
import { publicationAwait } from "./publication-io";
import { TEMPLATE_LOG_LIMITS, templateLogCursorSchema } from "./publication-log-contracts";
import { TemplateLogAccessError } from "./publication-log-provider";
import type { TemplatePublicationLogService } from "./publication-log-service";

const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
const failure = (code: string, status: number) =>
  Response.json({ error: code }, { status, headers });
export function templateLogRoute(deps: {
  enabled: () => boolean;
  session: () => Promise<SessionData | null>;
  service: () => TemplatePublicationLogService;
  retain?: (task: Promise<unknown>) => void;
}) {
  return async (request: Request, name: string, jobId: string) => {
    if (!deps.enabled()) return failure("logs_disabled", 404);
    const url = new URL(request.url);
    if (request.method !== "GET") return failure("invalid_request", 405);
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
    )
      return failure("invalid_origin", 403);
    const keys = [...url.searchParams.keys()],
      after = url.searchParams.get("after") ?? "0";
    if (
      keys.length > 1 ||
      keys.some((key) => key !== "after") ||
      !publicationNameSchema.safeParse(name).success ||
      !z.string().uuid().safeParse(jobId).success ||
      !templateLogCursorSchema.safeParse(after).success
    )
      return failure("invalid_request", 400);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(TEMPLATE_LOG_LIMITS.routeMs),
    ]);
    const bounded = <T>(task: Promise<T>) => {
      deps.retain?.(task.catch(() => {}));
      return publicationAwait(task, signal);
    };
    try {
      const session = await bounded(deps.session());
      if (!session) return failure("not_authenticated", 401);
      const page = await bounded(
        deps.service().read(
          {
            ownerId: session.user.id,
            coderUserId: session.user.coderUserId,
            sessionId: session.session.sessionId,
          },
          name,
          jobId,
          after,
          signal,
        ),
      );
      return Response.json(page, { headers });
    } catch (error) {
      if (error instanceof TemplateLogAccessError)
        return failure(
          error.code,
          error.code === "actor_revoked"
            ? 403
            : error.code === "not_found"
              ? 404
              : error.code === "identity_changed"
                ? 409
                : 503,
        );
      if (error instanceof TemplatePublicationError && error.code === "actor_revoked")
        return failure("not_authenticated", 401);
      return failure("logs_unavailable", 503);
    }
  };
}
