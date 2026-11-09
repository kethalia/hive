// LOCAL PROOF ONLY: no provider request, owner credential or actual workspace.
import { createHash, createPublicKey, verify } from "node:crypto";

let starts = 0,
  stalls = 0,
  calls = 0,
  mode = "normal";
export default {
  async fetch(request: Request, env: Record<string, string>) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json({ starts, calls, stalls });
    if (url.pathname === "/__mode") {
      mode = await request.text();
      return new Response(null, { status: 204 });
    }
    if (url.hostname === "127.0.0.1") return fetch(request); // fixed local PostgreSQL WS bridge
    calls++;
    if (url.hostname === "coder.reconcile-proof.invalid") {
      if (request.headers.get("Coder-Session-Token") !== "synthetic-coder-key")
        return new Response(null, { status: 401 });
      if (url.pathname === `/api/v2/workspaces/${env.WORKSPACE_ID}`)
        return Response.json({
          id: env.WORKSPACE_ID,
          name: "workspace",
          owner_name: "owner",
          owner_id: mode === "foreign-owner" ? env.OTHER_OWNER_ID : env.CODER_OWNER_ID,
          template_id: env.TEMPLATE_ID,
          latest_build: { id: env.BUILD_ID, status: "running" },
        });
      if (url.pathname === `/api/v2/workspacebuilds/${env.BUILD_ID}/resources`)
        return Response.json([
          {
            agents: [
              {
                id: env.AGENT_ID,
                name: "main",
                status: "connected",
                apps: [
                  {
                    id: env.APP_ID,
                    slug: "codex-session",
                    sharing_level: "owner",
                    subdomain: true,
                    external: false,
                    url: "http://127.0.0.1:13341",
                  },
                ],
              },
            ],
          },
        ]);
      if (url.pathname === "/api/v2/applications/host")
        return Response.json({ host: "*.apps.reconcile-proof.invalid" });
      if (url.pathname === "/api/v2/applications/auth-redirect") {
        const target = new URL(url.searchParams.get("redirect_uri") ?? "");
        if (target.origin !== env.APP_ORIGIN) throw new Error("Unexpected app");
        target.searchParams.set("coder_application_connect_api_key_35e783", "fixture");
        return new Response(null, { status: 303, headers: { Location: target.href } });
      }
    }
    if (url.origin === env.APP_ORIGIN) {
      const name = `coder_subdomain_app_session_token_${createHash("sha256").update("*.apps.reconcile-proof.invalid").digest("hex").slice(0, 32)}`;
      if (
        request.method === "GET" &&
        url.searchParams.get("coder_application_connect_api_key_35e783") === "fixture"
      )
        return new Response(null, {
          status: 303,
          headers: {
            Location: url.origin + url.pathname,
            "Set-Cookie": `${name}=fixture_cookie; Path=/; Secure; HttpOnly`,
          },
        });
      if (request.method === "POST" && request.headers.get("Cookie") === `${name}=fixture_cookie`) {
        const { ticket } = (await request.json()) as { ticket: string },
          parts = ticket.split(".");
        if (
          parts.length !== 3 ||
          !verify(
            null,
            Buffer.from(parts.slice(0, 2).join(".")),
            createPublicKey(env.ISSUER_PUBLIC_KEY),
            Buffer.from(parts[2], "base64url"),
          )
        )
          throw new Error("Invalid fixture host signature");
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
        if (
          claims.aud !== env.APP_ORIGIN ||
          claims.iss !== "https://hive.public-origin.invalid" ||
          claims.binding.ownerId !== env.CODER_OWNER_ID ||
          claims.binding.workspaceId !== env.WORKSPACE_ID
        )
          throw new Error("Wrong fixed scope");
        if (mode === "stall-start") {
          stalls++;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        request.signal.throwIfAborted();
        if (url.pathname === "/projects/tasks/start") starts++;
        return Response.json({
          schemaVersion: 1,
          projectId: claims.request.projectId,
          taskId: claims.request.taskId,
          phase: "preparing",
          nativeThreadId: null,
          terminalSessionName: null,
          reason: null,
        });
      }
    }
    return new Response(null, { status: 404 });
  },
};
