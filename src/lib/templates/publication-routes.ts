import { randomUUID } from "node:crypto";
import type { SessionData } from "@hive/auth";
import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { authorizeTemplateActor } from "./publication-actor";
import { type TemplateAssets, templatePublicationArtifact } from "./publication-artifact";
import { publicationNameSchema, TemplatePublicationError } from "./publication-contracts";
import { publicationBody } from "./publication-io";
import { CoderTemplatePublicationProvider } from "./publication-provider";
import { TemplateJobStore, templateJobTerminal } from "./publication-store";
import { provisionerTagsDigest } from "./publication-tags";

const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const failure = (status: number, error: string) => Response.json({ error }, { status, headers });
export function templatePublicationRoutes(deps: {
  db: () => PrismaClient;
  session: () => Promise<SessionData | null>;
  assets: TemplateAssets;
  kick: (ownerId: string) => Promise<void> | void;
}) {
  return {
    async push(request: Request, name: string) {
      if (
        request.method !== "POST" ||
        !publicationNameSchema.safeParse(name).success ||
        new URL(request.url).search
      )
        return failure(400, "Invalid publication request");
      if (
        request.headers.get("Origin") !== new URL(request.url).origin ||
        request.headers.get("Sec-Fetch-Site") === "cross-site"
      )
        return failure(403, "Origin rejected");
      const length = request.headers.get("Content-Length");
      if (length !== null && !/^0+$/.test(length))
        return failure(400, "Invalid publication request");
      if (request.body !== null) {
        try {
          await publicationBody(
            new Response(request.body),
            0,
            AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
          );
        } catch {
          return failure(400, "Invalid publication request");
        }
      }
      const requestId = request.headers.get("Idempotency-Key") ?? randomUUID();
      if (!z.string().uuid().safeParse(requestId).success)
        return failure(400, "Invalid publication request");
      try {
        const session = await deps.session();
        if (!session) return failure(401, "Not authenticated");
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
        const actor = await authorizeTemplateActor(
          deps.db(),
          {
            ownerId: session.user.id,
            coderUserId: session.user.coderUserId,
            sessionId: session.session.sessionId,
          },
          signal,
        );
        const provider = await CoderTemplatePublicationProvider.create(actor, fetch, signal);
        const target = await provider.locate(name);
        if (target.templateId && !target.activeVersionId)
          throw new TemplatePublicationError("provider_identity_mismatch");
        const tags = target.templateId
          ? provisionerTagsDigest(await provider.tags(target, target.activeVersionId ?? ""))
          : null;
        signal.throwIfAborted();
        const job = await new TemplateJobStore(deps.db()).enqueue(
          actor,
          templatePublicationArtifact(name),
          target,
          tags,
          requestId,
        );
        // The durable job survives a failed wake. A caller retry uses its same
        // request identity, and the hourly repair catches an interrupted handoff.
        await deps.kick(actor.ownerId);
        return Response.json({ jobId: job.id }, { headers });
      } catch (error) {
        const code =
          error instanceof TemplatePublicationError ? error.code : "publication_unavailable";
        return failure(
          ["publication_busy", "request_conflict"].includes(code)
            ? 409
            : code === "actor_revoked"
              ? 401
              : 503,
          code,
        );
      }
    },
    async stream(request: Request, name: string, id: string) {
      if (
        request.method !== "GET" ||
        !publicationNameSchema.safeParse(name).success ||
        !z.string().uuid().safeParse(id).success ||
        new URL(request.url).search
      )
        return failure(400, "Invalid publication request");
      if (request.headers.get("Sec-Fetch-Site") === "cross-site")
        return failure(403, "Origin rejected");
      const session = await deps.session();
      if (!session) return failure(401, "Not authenticated");
      const store = new TemplateJobStore(deps.db());
      if (!(await store.read(session.user.id, name, id)))
        return failure(404, "Publication not found");
      const control = new AbortController();
      const signal = AbortSignal.any([control.signal, request.signal, AbortSignal.timeout(25000)]);
      let canceled = false;
      let drained!: () => void;
      const finished = new Promise<void>((resolve) => {
        drained = resolve;
      });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (value: string) => {
            if (!canceled && !signal.aborted) controller.enqueue(encoder.encode(value));
          };
          const line = (value: string) => send(`data: ${value.replace(/[\r\n]/g, "")}\n\n`);
          let after = "0",
            bytes = 0;
          try {
            line("[template-push] Publication accepted");
            while (!signal.aborted && !canceled) {
              const job = await store.read(session.user.id, name, id);
              if (!job) return;
              if (job.state.versionId) {
                try {
                  const actor = await authorizeTemplateActor(deps.db(), job, signal);
                  const provider = await CoderTemplatePublicationProvider.create(
                    actor,
                    fetch,
                    signal,
                  );
                  const version = await provider.versionById(job.state.target, job.state.versionId);
                  if (
                    version.fileId !== job.state.fileId ||
                    version.message !== job.state.message ||
                    version.name !== job.state.versionName
                  )
                    throw new Error("Version changed");
                  const logs = await provider.logLines(job.state.versionId, after);
                  after = logs.after;
                  for (const value of logs.lines) {
                    bytes += Buffer.byteLength(value);
                    if (bytes > 4 * 1024 * 1024) throw new Error("Log view bound");
                    line(value);
                  }
                } catch {
                  if (templateJobTerminal(job.phase))
                    line("Detailed logs unavailable; inspect the import in Coder.");
                }
              }
              if (templateJobTerminal(job.phase)) {
                send(
                  `event: status\ndata: ${JSON.stringify({ success: job.phase === "succeeded", ...(job.phase === "succeeded" ? {} : { error: job.phase === "held" ? "Publication outcome requires review" : (job.reason ?? "Template push failed") }) })}\n\n`,
                );
                return;
              }
              send(": waiting for publication\n\n");
              await new Promise<void>((resolve) => {
                const timer = setTimeout(done, 1000);
                function done() {
                  clearTimeout(timer);
                  signal.removeEventListener("abort", done);
                  resolve();
                }
                signal.addEventListener("abort", done, { once: true });
                if (signal.aborted) done();
              });
            }
          } catch {
            /* Read failure closes this view; EventSource reconnects. */
          } finally {
            control.abort();
            try {
              controller.close();
            } catch {}
            drained();
          }
        },
        cancel() {
          canceled = true;
          control.abort();
          return finished;
        },
      });
      return new Response(stream, {
        headers: { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" },
      });
    },
  };
}
