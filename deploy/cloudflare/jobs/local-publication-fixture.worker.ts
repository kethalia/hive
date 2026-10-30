// LOCAL TEST ONLY. Synthetic authentication and a fake Coder API; never deployed.
type Env = {
  PROOF_BEARER: string;
  AUTH_SERVICE_SECRET: string;
  OWNER_ID: string;
  CODER_USER_ID: string;
  SESSION_ID: string;
  CODER_URL: string;
};
let mode = "success",
  templateId = "",
  organizationId = "",
  activeVersionId = "";
const files = new Map<string, ArrayBuffer>(),
  versions = new Map<string, Record<string, unknown>>();
let effects = { uploads: 0, versions: 0, activations: 0 };
export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (
      path === "/__fixture/config" &&
      request.method === "POST" &&
      request.headers.get("Authorization") === `Bearer ${env.PROOF_BEARER}`
    ) {
      const value = (await request.json()) as {
        mode: string;
        templateId: string;
        organizationId: string;
        activeVersionId: string;
      };
      mode = value.mode;
      templateId = value.templateId;
      organizationId = value.organizationId;
      activeVersionId = value.activeVersionId;
      files.clear();
      versions.clear();
      effects = { uploads: 0, versions: 0, activations: 0 };
      return Response.json({ configured: true });
    }
    if (
      path === "/__fixture/counts" &&
      request.headers.get("Authorization") === `Bearer ${env.PROOF_BEARER}`
    )
      return Response.json(effects);
    if (path.startsWith("/sessions/")) {
      if (
        request.method !== "GET" ||
        request.headers.get("Authorization") !== `Bearer ${env.AUTH_SERVICE_SECRET}`
      )
        return new Response(null, { status: 404 });
      if (path === `/sessions/${env.SESSION_ID}`)
        return Response.json({
          sessionId: env.SESSION_ID,
          userId: env.OWNER_ID,
          coderUserId: env.CODER_USER_ID,
          coderUrl: env.CODER_URL,
          username: "synthetic",
          email: "synthetic@example.invalid",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        });
      if (path === `/sessions/${env.SESSION_ID}/token`)
        return Response.json({
          token: "synthetic-credential-never-real",
          coderUrl: env.CODER_URL,
          expiresAt: null,
        });
      return new Response(null, { status: 404 });
    }
    if (request.headers.get("Coder-Session-Token") !== "synthetic-credential-never-real")
      return new Response(null, { status: 401 });
    if (path === "/api/v2/users/me") return Response.json({ id: env.CODER_USER_ID });
    if (path === "/api/v2/organizations/default")
      return Response.json({ id: organizationId, name: "default" });
    if (
      path === `/api/v2/organizations/${organizationId}/templates/ai-dev-k8s` ||
      path === `/api/v2/templates/${templateId}`
    )
      return Response.json({
        id: templateId,
        name: "ai-dev-k8s",
        organization_id: organizationId,
        organization_name: "default",
        active_version_id: activeVersionId,
        deleted: false,
      });
    if (path === "/api/v2/authcheck") return Response.json({ publish: true });
    if (path === "/api/v2/files" && request.method === "POST") {
      const id = crypto.randomUUID();
      files.set(id, await request.arrayBuffer());
      effects.uploads++;
      return Response.json({ hash: id }, { status: 201 });
    }
    if (path.startsWith("/api/v2/files/") && request.method === "GET") {
      const value = files.get(path.split("/").at(-1) ?? "");
      return value ? new Response(value) : new Response(null, { status: 404 });
    }
    if (
      path === `/api/v2/organizations/${organizationId}/templateversions` &&
      request.method === "POST"
    ) {
      const value = (await request.json()) as {
        name: string;
        message: string;
        file_id: string;
        template_id: string;
      };
      const id = crypto.randomUUID();
      const version = {
        id,
        name: value.name,
        message: value.message,
        organization_id: organizationId,
        template_id: templateId,
        archived: false,
        created_by: { id: env.CODER_USER_ID },
        job: {
          id: crypto.randomUUID(),
          organization_id: organizationId,
          initiator_id: env.CODER_USER_ID,
          file_id: value.file_id,
          type: "template_version_import",
          status: "succeeded",
          logs_overflowed: false,
        },
      };
      versions.set(id, version);
      effects.versions++;
      return mode === "version_unknown"
        ? new Response(null, { status: 500 })
        : Response.json(version, { status: 201 });
    }
    if (path === `/api/v2/templates/${templateId}/versions` && request.method === "PATCH") {
      const value = (await request.json()) as { id: string };
      activeVersionId = value.id;
      effects.activations++;
      return mode === "activation_unknown"
        ? new Response(null, { status: 500 })
        : Response.json({ message: "synthetic activation" });
    }
    if (path.startsWith(`/api/v2/templates/${templateId}/versions/`)) {
      if (mode === "version_unknown") return new Response(null, { status: 404 });
      const name = path.split("/").at(-1);
      const version = [...versions.values()].find((v) => v.name === name);
      return version ? Response.json(version) : new Response(null, { status: 404 });
    }
    if (path.startsWith("/api/v2/templateversions/")) {
      if (path.endsWith("/logs"))
        return Response.json([{ id: 1, output: "synthetic-secret-never-in-controller-journal" }]);
      const version = versions.get(path.split("/").at(-1) ?? "");
      return version ? Response.json(version) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  },
};
