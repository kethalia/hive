import type { SessionData } from "@hive/auth";
import { getConfiguredCoderUrl } from "@hive/auth";
import { z } from "zod";
import {
  publicationCodeSchema,
  publicationLabels,
  publicationNameSchema,
  TemplatePublicationError,
} from "./publication-contracts";
import { publicationAwait } from "./publication-io";
import type { TemplatePublicationService } from "./publication-service";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export type PublicationRouteDependencies = {
  enabled: () => boolean;
  session: () => Promise<SessionData | null>;
  service: () => TemplatePublicationService;
  streamMs?: number;
  pollMs?: number;
  /** Keep timed-out underlying operations in the request's DB lifetime until settled. */
  retain?: (task: Promise<unknown>) => void;
};
const error = (code: string, status: number) => Response.json({ error: code }, { status, headers });
/** Browser-only routes. No request body can select an artifact, actor, provider URL or activation target. */
export function templatePublicationRoutes(dependencies: PublicationRouteDependencies) {
  const bounded = <T>(task: Promise<T>, signal: AbortSignal) => {
    dependencies.retain?.(task.catch(() => {}));
    return publicationAwait(task, signal);
  };
  const initialSignal = (request: Request) =>
    AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  return {
    async push(request: Request, name: string) {
      if (!dependencies.enabled()) return error("publication_disabled", 404);
      const url = new URL(request.url);
      if (
        request.headers.get("origin") !== url.origin ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return error("invalid_origin", 403);
      if (url.search || !publicationNameSchema.safeParse(name).success || request.body !== null)
        return error("invalid_request", 400);
      const key = request.headers.get("idempotency-key");
      if (key !== null && !z.string().uuid().safeParse(key).success)
        return error("invalid_request", 400);
      try {
        const signal = initialSignal(request);
        const session = await bounded(dependencies.session(), signal);
        if (!session) return error("not_authenticated", 401);
        const job = await bounded(
          dependencies.service().enqueue(
            {
              ownerId: session.user.id,
              coderUserId: session.user.coderUserId,
              sessionId: session.session.sessionId,
            },
            name,
            key ?? undefined,
          ),
          signal,
        );
        return Response.json({ jobId: job.id }, { headers });
      } catch (e) {
        const code = e instanceof TemplatePublicationError ? e.code : "publication_unavailable";
        return error(
          code,
          code === "actor_revoked"
            ? 401
            : ["publication_busy", "request_conflict"].includes(code)
              ? 409
              : code === "missing_template"
                ? 404
                : 503,
        );
      }
    },
    async stream(request: Request, name: string, jobId: string) {
      if (!dependencies.enabled()) return error("publication_disabled", 404);
      if (request.headers.get("sec-fetch-site") === "cross-site")
        return error("invalid_origin", 403);
      if (
        new URL(request.url).search ||
        !publicationNameSchema.safeParse(name).success ||
        !z.string().uuid().safeParse(jobId).success
      )
        return error("invalid_request", 400);
      try {
        const signal = initialSignal(request);
        const session = await bounded(dependencies.session(), signal);
        if (!session) return error("not_authenticated", 401);
        const store = dependencies.service().store,
          first = await bounded(store.read(session.user.id, name, jobId), signal);
        if (!first) return error("publication_not_found", 404);
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            const streamSignal = AbortSignal.any([
              request.signal,
              AbortSignal.timeout(Math.max(1, Math.min(25000, dependencies.streamMs ?? 25000))),
            ]);
            let sequence = 0;
            const until = Date.now() + Math.min(25000, dependencies.streamMs ?? 25000);
            const send = (value: string) => {
              if (!cancelled && !request.signal.aborted) controller.enqueue(encoder.encode(value));
            };
            try {
              let job = first;
              while (!cancelled && !request.signal.aborted) {
                const current = await bounded(dependencies.session(), streamSignal);
                if (
                  !current ||
                  current.user.id !== session.user.id ||
                  current.session.sessionId !== session.session.sessionId
                )
                  return;
                for (const event of job.events) {
                  if (event.sequence <= sequence) continue;
                  const code = publicationCodeSchema.safeParse(event.code);
                  if (!code.success) return;
                  send(`data: ${publicationLabels[code.data]}\n\n`);
                  if (
                    code.data === "version_verified" &&
                    job.versionId &&
                    job.target.configuredOrigin === getConfiguredCoderUrl() &&
                    [job.target.organizationName, job.templateName, job.versionName].every((v) =>
                      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v),
                    )
                  )
                    send(
                      `data: Detailed output: ${job.target.configuredOrigin}/templates/${job.target.organizationName}/${job.templateName}/versions/${job.versionName}\n\n`,
                    );
                  sequence = event.sequence;
                }
                if (["succeeded", "failed", "held"].includes(job.stage)) {
                  send(
                    `event: status\ndata: ${JSON.stringify({ success: job.stage === "succeeded", ...(job.stage !== "succeeded" ? { error: job.stage === "held" ? "Publication held for review" : "Template import failed" } : {}) })}\n\n`,
                  );
                  return;
                }
                if (Date.now() >= until) return;
                send(": waiting for template publication\n\n");
                await publicationAwait(
                  new Promise((resolve) =>
                    setTimeout(resolve, Math.min(1000, dependencies.pollMs ?? 1000)),
                  ),
                  streamSignal,
                );
                const next = await bounded(store.read(session.user.id, name, jobId), streamSignal);
                if (!next) return;
                job = next;
              }
            } catch {
              /* A transient read failure closes SSE; the client retries the complete immutable journal. */
            } finally {
              try {
                controller.close();
              } catch {}
            }
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream, {
          headers: { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" },
        });
      } catch {
        return error("publication_unavailable", 503);
      }
    },
  };
}
