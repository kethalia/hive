import { createHash } from "node:crypto";
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
    return Response.json({ sessions: sessions.sessions, installed, disabled, workspaceReads });
  },
};
