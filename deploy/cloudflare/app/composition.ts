import { authServiceHeaders } from "@hive/auth";
import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import type { HostCallbackCapabilities } from "../../../src/lib/codex-session/host-callback-transport";
import {
  type ProjectReconcileEnvironment,
  projectReconcilePath,
} from "../../../src/lib/projects/reconcile-transport";
import { withTaskWakeEnvironment } from "../../../src/lib/projects/task-wake.server";
import type { TaskWakeEnvironment } from "../../../src/lib/projects/task-wake-contracts";
import { isAgentNotificationCallback } from "./agent-notifications";
import { type AutomaticHealthEnvironment, automaticWorkerHealth } from "./automatic-health";
import { genericTerminalPath } from "./generic-terminal-relay";
import { type GenericTerminalEnvironment, genericTerminalRelay } from "./generic-terminal-runtime";
import { isHostCallbackTransport } from "./host-callback";
import {
  boundPortableActionBody,
  isPortableDiscovery,
  isPortableServerAction,
  isUnsupportedPageMutation,
  type PortableActions,
} from "./portable-actions";
import {
  authorizePreview,
  bootstrapPreview,
  previewAccessMode,
  privatePreviewResponse,
  requiresPreviewAccess,
  runtimeRelayDeadline,
  withoutPreviewCredential,
} from "./preview-auth";
import { projectRelayPath } from "./project-relay";
import { type ProjectRelayEnvironment, projectRelay } from "./project-relay-runtime";
import { runProjectTaskReconciliation } from "./project-tasks";
import {
  boundedReleaseJson,
  RELEASE_HEALTH_PATH,
  releaseAuthReadiness,
  releaseHealth,
} from "./release-health";
import { runReleaseSchedule } from "./release-scheduled";
import { runRequestLifetime } from "./request-lifetime";
import { isPortableTemplatePublication } from "./template-publications";
import { type TerminalPasteEnvironment, terminalPastePath } from "./terminal-paste-runtime";
import { type VoiceEnvironment, voicePath, voiceRuntime } from "./voice-runtime";

type Environment = TaskWakeEnvironment &
  AutomaticHealthEnvironment &
  ProjectRelayEnvironment &
  GenericTerminalEnvironment &
  TerminalPasteEnvironment &
  VoiceEnvironment &
  ProjectReconcileEnvironment &
  HostCallbackCapabilities & {
    DATABASE_URL?: string;
    AUTH_SERVICE?: { fetch: typeof fetch };
    PREVIEW_BEARER?: string;
    PREVIEW_COOKIE_SECRET?: string;
    HIVE_PREVIEW_ORIGIN?: string;
    HIVE_TEMPLATE_PUBLICATION_ENABLED?: string;
    HIVE_TEMPLATE_LOG_VIEW_ENABLED?: string;
    HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED?: string;
    HIVE_AGENT_NOTIFICATION_SOURCES_ENABLED?: string;
    HIVE_PROJECT_DISCOVERY_ENABLED?: string;
    HIVE_AGENT_TOOLS_ENABLED?: string;
    HIVE_AGENT_TOOLS_TRANSPORT?: string;
    HIVE_DELIVERY_RELEASE_ENABLED?: string;
    HIVE_DELIVERY_RELEASE_SCHEDULER_ENABLED?: string;
    HIVE_RELEASE_HEALTH_ENABLED?: string;
    HIVE_RELEASE_PROBE_SECRET?: string;
    HIVE_RELEASE_SOURCE_SHA?: string;
    HIVE_RELEASE_ARTIFACT_DIGEST?: string;
    HIVE_NATIVE_MODE?: string;
    HIVE_NATIVE_PRODUCTION_ACTIVE?: string;
    HIVE_NATIVE_PREVIEW_ENABLED?: string;
  };
type Context = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

export function createAppWorker(
  framework: { fetch(request: Request, env: Environment, context: Context): Promise<Response> },
  portableActions: PortableActions,
) {
  return {
    scheduled(event: { cron: string }, env: Environment, context: Context) {
      context.waitUntil(
        runReleaseSchedule(event, env, async (signal) => {
          const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
            queryTimeoutMillis: 10000,
            transactionTimeoutMillis: 10000,
          });
          try {
            await database.run(async () => {
              const { createInstalledReleaseController } = await import(
                "../../../src/lib/delivery/release-installed.server"
              );
              const variables = Object.fromEntries(
                Object.entries(env).filter(([, value]) => typeof value === "string"),
              ) as Record<string, string>;
              const controller = createInstalledReleaseController(getDb(), variables);
              if (!controller) throw Error("release_schedule_unavailable");
              await controller.scheduler.tick(signal);
            });
          } finally {
            await database.close();
          }
        }),
      );
    },
    async fetch(request: Request, env: Environment, context: Context): Promise<Response> {
      const accessMode = previewAccessMode(env);
      if (accessMode === "unavailable")
        return Response.json(
          { error: "Deployment unavailable." },
          { status: 503, headers: { "Cache-Control": "private, no-store" } },
        );
      if (projectReconcilePath(request)) {
        return runProjectTaskReconciliation(request, env, context, (tracked) =>
          env.HIVE_PROJECT_TASK_WAKE_ENABLED === "true"
            ? withTaskWakeEnvironment(env, () => framework.fetch(request, env, tracked))
            : framework.fetch(request, env, tracked),
        );
      }
      const privateAccess = requiresPreviewAccess(env);
      const notificationCallback = isAgentNotificationCallback(
        request,
        env.HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED,
        env,
      );
      const cookieOptions = {
        cookieSecret: env.PREVIEW_COOKIE_SECRET,
        origin: env.HIVE_PREVIEW_ORIGIN,
      };
      if (
        privateAccess &&
        !notificationCallback &&
        !isHostCallbackTransport(request, env.HIVE_CODEX_GATEWAY_ENABLED, env)
      ) {
        const bootstrap = await bootstrapPreview(request, env.PREVIEW_BEARER, cookieOptions);
        if (bootstrap) return bootstrap;
        const unauthorized = authorizePreview(request, env.PREVIEW_BEARER, cookieOptions);
        if (unauthorized) return unauthorized;
      }
      const previewExpiresAt = runtimeRelayDeadline(request, env, env.PREVIEW_COOKIE_SECRET);
      if (privateAccess && !notificationCallback) request = withoutPreviewCredential(request);
      if (new URL(request.url).pathname === RELEASE_HEALTH_PATH) {
        const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
          queryTimeoutMillis: 2000,
          transactionTimeoutMillis: 3000,
        });
        return runRequestLifetime(database, context, () =>
          env.HIVE_NATIVE_HEALTH_ENABLED === "true"
            ? automaticWorkerHealth(
                request,
                env,
                async () => {
                  const result = await getDb().$queryRaw<{ value: number }[]>`SELECT 1 AS value`;
                  return result.length === 1 && Number(result[0].value) === 1;
                },
                async (signal) => {
                  if (!env.AUTH_SERVICE || !env.AUTH_SERVICE_SECRET) return false;
                  const response = await env.AUTH_SERVICE.fetch(
                    new Request("https://auth.internal/readiness", {
                      signal,
                      headers: authServiceHeaders(env.AUTH_SERVICE_SECRET),
                    }),
                  );
                  try {
                    if (!response.ok || response.redirected) return false;
                    const payload = await boundedReleaseJson(response, 1024, signal);
                    return (
                      !!payload &&
                      typeof payload === "object" &&
                      (payload as { status?: unknown }).status === "ready" &&
                      (payload as { coverage?: unknown }).coverage === "db-config-crypto-smoke"
                    );
                  } finally {
                    void response.body?.cancel().catch(() => {});
                  }
                },
              )
            : releaseHealth(
                request,
                env,
                "app",
                async () => {
                  const result = await getDb().$queryRaw<{ value: number }[]>`SELECT 1 AS value`;
                  return result.length === 1 && Number(result[0].value) === 1;
                },
                async () => {
                  if (!env.AUTH_SERVICE || !env.HIVE_RELEASE_PROBE_SECRET)
                    throw new Error("auth unavailable");
                  const service = env.AUTH_SERVICE;
                  return releaseAuthReadiness(
                    (probe) => service.fetch(probe),
                    env.HIVE_RELEASE_PROBE_SECRET,
                    request.signal,
                  );
                },
              ),
        );
      }
      if (genericTerminalPath(request))
        return genericTerminalRelay(request, env, previewExpiresAt, context);
      if (projectRelayPath(request)) return projectRelay(request, env, previewExpiresAt, context);
      if (voicePath(request)) return voiceRuntime(request, env, previewExpiresAt, context);
      const pathname = new URL(request.url).pathname;
      // These paths still need the scoped host bridge and durable jobs. The
      // compatibility preview fails explicitly rather than executing Node stubs.
      const requiresHost =
        request.headers.has("Upgrade") ||
        isUnsupportedPageMutation(request, portableActions) ||
        (request.headers.has("Next-Action") && !isPortableServerAction(request, portableActions)) ||
        (pathname.startsWith("/api/templates/") &&
          !isPortableTemplatePublication(
            request,
            env.HIVE_TEMPLATE_PUBLICATION_ENABLED,
            env.HIVE_TEMPLATE_LOG_VIEW_ENABLED,
          )) ||
        (pathname.startsWith("/api/discovery/") &&
          !isPortableDiscovery(
            request,
            env.HIVE_AGENT_TOOLS_ENABLED === "true" &&
              env.HIVE_AGENT_TOOLS_TRANSPORT === "workspace-app",
            env.HIVE_WORKSPACE_READ_ENABLED === "true",
          )) ||
        (pathname === "/api/projects" &&
          !(
            request.method === "GET" &&
            env.HIVE_PROJECT_DISCOVERY_ENABLED === "true" &&
            env.HIVE_CODEX_GATEWAY_ENABLED === "true"
          )) ||
        pathname.startsWith("/api/workspace-proxy") ||
        (pathname === "/api/auth/terminal-ticket" &&
          env.HIVE_GENERIC_TERMINAL_ENABLED !== "true") ||
        (pathname === "/api/notifications/events" && !notificationCallback) ||
        (pathname === "/api/notifications/sources" &&
          request.method !== "GET" &&
          !(
            env.HIVE_AGENT_NOTIFICATION_SOURCES_ENABLED === "true" &&
            ["POST", "DELETE"].includes(request.method) &&
            !request.url.includes("?")
          )) ||
        (/^\/api\/workspaces\/[^/]+\/(voice|terminal\/paste-assets)(\/|$)/.test(pathname) &&
          !(
            env.HIVE_TERMINAL_PASTE_ENABLED === "true" &&
            request.method === "POST" &&
            terminalPastePath(request)
          ));
      if (requiresHost)
        return Response.json(
          { error: "This capability requires the scoped host bridge or durable job adapter." },
          { status: 503, headers: { "Cache-Control": "private, no-store" } },
        );
      if (pathname === "/api/auth/login" && !env.AUTH_SERVICE)
        return Response.json(
          { error: "Preview authentication service is not configured." },
          { status: 503, headers: { "Cache-Control": "private, no-store" } },
        );
      if (request.headers.has("Next-Action")) {
        const bounded = await boundPortableActionBody(request, portableActions);
        if (bounded instanceof Response) return bounded;
        request = bounded;
      }
      const database = createCloudflareDatabaseRequest(env.DATABASE_URL);
      return privatePreviewResponse(
        await runRequestLifetime(database, context, (tracked) =>
          env.HIVE_PROJECT_TASK_WAKE_ENABLED === "true"
            ? withTaskWakeEnvironment(env, () => framework.fetch(request, env, tracked))
            : framework.fetch(request, env, tracked),
        ),
      );
    },
  };
}
