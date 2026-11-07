import { createHash, randomUUID } from "node:crypto";
import { AgentBridgeService } from "../../src/lib/agents/portable-service.server";
import { requestVerifiedWorkspaceAgent } from "../../src/lib/codex-session/bootstrap-delivery.server";
export default {
  async fetch(request: Request, env: { CONFIG: string; TARGET: string }) {
    const path = new URL(request.url).pathname;
    if (!["/proof", "/wrong-owner", "/changed-build"].includes(path))
      return new Response(null, { status: 404 });
    const config = JSON.parse(env.CONFIG),
      binding = config.binding;
    let workspaceReads = 0,
      appCalls = 0;
    const coder = {
      getBaseUrl: () => binding.coderOrigin,
      getApplicationsHost: async () => "*.apps.example.com",
      getApplicationAuthRedirect: async (url: string) =>
        `${url}?coder_application_connect_api_key_35e783=fixture`,
      getWorkspace: async () => {
        workspaceReads++;
        return {
          id: binding.workspaceId,
          owner_id:
            path === "/wrong-owner" ? "00000000-0000-4000-8000-000000000001" : binding.ownerId,
          owner_name: "owner",
          name: "work",
          template_id: binding.templateId,
          latest_build: {
            id:
              path === "/changed-build" && workspaceReads > 2
                ? "00000000-0000-4000-8000-000000000002"
                : binding.buildId,
            status: "running",
          },
        };
      },
      getWorkspaceResources: async () => [
        {
          agents: [
            {
              id: binding.agentId,
              name: "main",
              status: "connected",
              apps: [
                {
                  id: binding.appId,
                  slug: "hive-agent",
                  sharing_level: "owner",
                  subdomain: true,
                  external: false,
                  url: "http://127.0.0.1:13344",
                },
              ],
            },
          ],
        },
      ],
    };
    const cookieName = `coder_subdomain_app_session_token_${createHash("sha256").update("*.apps.example.com").digest("hex").slice(0, 32)}`;
    const fetcher: typeof fetch = (input, init) => {
      appCalls++;
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.search)
        return Promise.resolve(
          new Response(null, {
            status: 303,
            headers: {
              Location: url.pathname,
              "Set-Cookie": `${cookieName}=fixture; Path=/; HttpOnly; Secure`,
            },
          }),
        );
      return fetch(env.TARGET, init);
    };
    const service = new AgentBridgeService(
      {
        issuer: config.issuer,
        keyId: config.keyId,
        privateKeyPem: config.privateKeyPem,
        home: config.home,
        cookieDomains: [],
        pins: [
          {
            templateId: binding.templateId,
            profile: config.profile,
            manifestSha256: config.manifestSha256,
            helperSha256: config.helperSha256,
          },
        ],
      },
      {
        coderForPrincipal: async () => coder as never,
        transport: (provider, target) => (ticket, expiresAt, signal) =>
          requestVerifiedWorkspaceAgent(provider, target, { ticket, expiresAt, signal }, fetcher),
      },
    );
    const principal = { hiveUserId: config.hiveUserId, coderUserId: binding.ownerId };
    if (path !== "/proof") {
      try {
        await service.execute(principal, binding.workspaceId, {
          operation: path === "/wrong-owner" ? "sessions" : "install",
        });
        return Response.json({ rejected: false });
      } catch (error) {
        return Response.json({ rejected: true, code: (error as { code?: string }).code, appCalls });
      }
    }
    const sessions = await service.execute(principal, binding.workspaceId, {
      operation: "sessions",
    });
    const installed = await service.execute(principal, binding.workspaceId, {
      operation: "install",
    });
    const disabled = await service.execute(principal, binding.workspaceId, {
      operation: "disable",
    });
    const operation = {
      operation: "install-notifications" as const,
      sourceId: randomUUID(),
      generation: 1,
      createdAt: "2026-11-06T00:00:00.000Z",
      token: "d".repeat(64),
    };
    const notification = await service.execute(principal, binding.workspaceId, operation);
    const replay = await service.execute(principal, binding.workspaceId, operation);
    const account = await service.execute(principal, binding.workspaceId, {
      operation: "codex-account",
      account: { action: "status" },
    });
    const connecting = await service.execute(principal, binding.workspaceId, {
      operation: "codex-account",
      account: {
        action: "connect",
        lifetimeId: account.lifetimeId,
        generation: account.generation,
      },
    });
    const cancelled = await service.execute(principal, binding.workspaceId, {
      operation: "codex-account",
      account: {
        action: "cancel",
        lifetimeId: connecting.lifetimeId,
        generation: connecting.generation,
      },
    });
    const claude = await service.execute(principal, binding.workspaceId, {
      operation: "claude-account",
      account: { action: "status" },
    });
    const cliPending = await service.execute(principal, binding.workspaceId, {
      operation: "claude-account",
      account: { action: "connect", lifetimeId: claude.lifetimeId, generation: claude.generation },
    });
    const cliCode = await service.execute(principal, binding.workspaceId, {
      operation: "claude-account",
      account: {
        action: "code",
        lifetimeId: cliPending.lifetimeId,
        generation: cliPending.generation,
        code: "SYNTHETIC_CODE#STATE",
      },
    });
    const cliConnected = await service.execute(principal, binding.workspaceId, {
      operation: "claude-account",
      account: { action: "status" },
    });
    const cliDisconnected = await service.execute(principal, binding.workspaceId, {
      operation: "claude-account",
      account: {
        action: "disconnect",
        lifetimeId: cliConnected.lifetimeId,
        generation: cliConnected.generation,
      },
    });
    const cliAgain = await service.execute(principal, binding.workspaceId, {
      operation: "claude-account",
      account: {
        action: "connect",
        lifetimeId: cliDisconnected.lifetimeId,
        generation: cliDisconnected.generation,
      },
    });
    const cliCancelled = await service.execute(principal, binding.workspaceId, {
      operation: "claude-account",
      account: {
        action: "cancel",
        lifetimeId: cliAgain.lifetimeId,
        generation: cliAgain.generation,
      },
    });
    return Response.json({
      claudeAccountFenced:
        claude.scope === "workspace-cli" &&
        cliPending.state === "pending" &&
        cliCode.pending?.codeSubmitted === true &&
        cliConnected.state === "signed-in" &&
        cliDisconnected.state === "signed-out" &&
        cliCancelled.state === "cancelled",
      codexAccountFenced:
        account.scope === "managed-native" &&
        connecting.state === "pending" &&
        cancelled.state === "cancelled" &&
        cancelled.generation > connecting.generation,
      sessions: sessions.sessions,
      installed,
      disabled,
      workspaceReads,
      notificationInstalled:
        notification.sourceId === operation.sourceId && notification.generation === 1,
      notificationReplay: replay.sourceId === operation.sourceId && replay.generation === 1,
    });
  },
};
