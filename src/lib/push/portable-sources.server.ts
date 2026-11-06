import { getConfiguredCoderUrl, type SessionData } from "@hive/auth";
import { getDb } from "@hive/db";
import { z } from "zod";
import { AgentBridgeError } from "@/lib/agents/portable-client.server";
import {
  createPortableAgentService,
  portableAgentConfig,
} from "@/lib/agents/portable-config.server";
import { type AgentOperation, agentResultSchemas } from "@/lib/agents/portable-contracts";
import { getRequestSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { publicationBody } from "@/lib/templates/publication-io";
import {
  callbackTokenHash,
  confirmNotificationCredential,
  stageNotificationCredential,
} from "./source-credentials";

type Install = Extract<AgentOperation, { operation: "install-notifications" }>;
export type PortableNotificationSourceDependencies = {
  enabled(): boolean;
  origin(): string;
  session(): Promise<SessionData | null>;
  prepare(
    user: SessionData["user"],
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<{
    workspaceName: string;
    install(request: Install, signal: AbortSignal): Promise<unknown>;
  }>;
  stage: typeof stageNotificationCredential;
  confirm: typeof confirmNotificationCredential;
  isCurrent(ownerId: string, workspaceId: string, request: Install): Promise<boolean>;
  revoke(user: SessionData["user"], workspaceId: string): Promise<void>;
};
const headers = { "Cache-Control": "private, no-store" };
const bodySchema = z.object({ workspaceId: z.string().uuid() }).strict();
function fixedOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password)
    throw new Error();
  return value;
}
export function portableNotificationSourceRoutes(deps: PortableNotificationSourceDependencies) {
  return async (request: Request) => {
    if (!deps.enabled())
      return Response.json({ error: "sources_disabled" }, { status: 404, headers });
    if (!["POST", "DELETE"].includes(request.method))
      return new Response(null, { status: 405, headers });
    let origin: string;
    try {
      origin = fixedOrigin(deps.origin());
    } catch {
      return Response.json({ error: "sources_unavailable" }, { status: 503, headers });
    }
    const url = new URL(request.url);
    if (
      url.origin !== origin ||
      request.headers.get("Origin") !== origin ||
      url.search ||
      request.url.includes("?") ||
      request.headers.get("Sec-Fetch-Site") === "cross-site"
    )
      return new Response(null, { status: 403, headers });
    try {
      const session = await deps.session();
      if (!session) return new Response(null, { status: 401, headers });
      if (!request.body) return new Response(null, { status: 400, headers });
      let workspaceId: string;
      try {
        const bytes = await publicationBody(
          new Response(request.body),
          1024,
          AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
        );
        workspaceId = bodySchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        ).workspaceId;
      } catch {
        return new Response(null, { status: 400, headers });
      }
      request.signal.throwIfAborted();
      if (request.method === "DELETE") {
        // Pure owner-scoped revocation must work while a workspace/bridge is stopped,
        // unavailable or already deleted. It never starts or reinstalls anything.
        await deps.revoke(session.user, workspaceId);
        return Response.json({ success: true }, { headers });
      }
      const prepared = await deps.prepare(session.user, workspaceId, request.signal);
      request.signal.throwIfAborted();
      const { source, token } = await deps.stage(
        session.user.id,
        workspaceId,
        prepared.workspaceName,
      );
      const operation: Install = {
        operation: "install-notifications",
        sourceId: source.id,
        generation: source.credentialGeneration,
        createdAt: source.createdAt.toISOString(),
        token,
      };
      request.signal.throwIfAborted();
      const receipt = agentResultSchemas["install-notifications"].parse(
        await prepared.install(operation, request.signal),
      );
      if (
        receipt.sourceId !== operation.sourceId ||
        receipt.generation !== operation.generation ||
        receipt.createdAt !== operation.createdAt ||
        receipt.credentialHash !== callbackTokenHash(token) ||
        receipt.callbackOrigin !== origin
      )
        throw new AgentBridgeError("outcome_unknown");
      request.signal.throwIfAborted();
      const confirmed = await deps.confirm(
        source.id,
        operation.generation,
        token,
        prepared.workspaceName,
        request.signal,
      );
      request.signal.throwIfAborted();
      if (!confirmed && !(await deps.isCurrent(session.user.id, workspaceId, operation)))
        throw new AgentBridgeError("outcome_unknown");
      return Response.json({ success: true }, { headers });
    } catch (error) {
      const unknown =
        request.signal.aborted ||
        (error instanceof AgentBridgeError && error.code === "outcome_unknown");
      return Response.json(
        { error: unknown ? "setup_outcome_unknown" : "sources_unavailable" },
        { status: unknown ? 409 : 503, headers },
      );
    }
  };
}

export const cloudflareNotificationSourcesRoute = portableNotificationSourceRoutes({
  enabled: () => process.env.HIVE_AGENT_NOTIFICATION_SOURCES_ENABLED === "true",
  origin: () => process.env.HIVE_PUBLIC_ORIGIN ?? "",
  session: getRequestSession,
  async prepare(user, workspaceId, signal) {
    if (process.env.HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED !== "true")
      throw new AgentBridgeError("unavailable");
    const config = portableAgentConfig();
    if (config.issuer !== fixedOrigin(process.env.HIVE_PUBLIC_ORIGIN ?? ""))
      throw new AgentBridgeError("unavailable");
    const coder = await getCoderClientForUser(user.id, { signal });
    const workspace = await coder.getWorkspace(workspaceId, signal);
    if (
      workspace.id !== workspaceId ||
      workspace.owner_id !== user.coderUserId ||
      workspace.latest_build.status !== "running" ||
      !config.pins.some((pin) => pin.templateId === workspace.template_id)
    )
      throw new AgentBridgeError("unavailable");
    const bridge = createPortableAgentService(config),
      principal = { hiveUserId: user.id, coderUserId: user.coderUserId };
    // Confirm the installed pinned bridge before reserving a callback credential.
    await bridge.execute(principal, workspaceId, { operation: "inventory" }, signal);
    return {
      workspaceName: workspace.name,
      install: (operation, callerSignal) =>
        bridge.execute(principal, workspaceId, operation, callerSignal),
    };
  },
  stage: stageNotificationCredential,
  confirm: confirmNotificationCredential,
  async isCurrent(ownerId, workspaceId, request) {
    const row = await getDb().notificationSource.findFirst({
      where: {
        id: request.sourceId,
        userId: ownerId,
        workspaceId,
        credentialGeneration: request.generation,
        tokenHash: callbackTokenHash(request.token),
        pendingTokenHash: null,
      },
    });
    return !!row;
  },
  async revoke(user, workspaceId) {
    const origin = getConfiguredCoderUrl();
    await getDb().$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id=${user.id}::uuid AND coder_user_id=${user.coderUserId}::uuid AND coder_url=${origin} FOR SHARE`;
        if (!rows[0]) throw new AgentBridgeError("unavailable");
        await tx.notificationSource.deleteMany({ where: { userId: user.id, workspaceId } });
      },
      { timeout: 10000, maxWait: 10000 },
    );
  },
});
