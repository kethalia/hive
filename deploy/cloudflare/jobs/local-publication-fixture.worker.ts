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
let templateExists = true,
  priorVersionId = "";
const files = new Map<string, ArrayBuffer>(),
  versions = new Map<string, Record<string, unknown>>();
let effects = { uploads: 0, versions: 0, activations: 0, templateCreations: 0 };
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
      priorVersionId = activeVersionId;
      templateExists = !mode.startsWith("first_");
      files.clear();
      versions.clear();
      effects = { uploads: 0, versions: 0, activations: 0, templateCreations: 0 };
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
    ) {
      if (!templateExists) return new Response(null, { status: 404 });
      return Response.json({
        id: templateId,
        name: "ai-dev-k8s",
        organization_id: organizationId,
        organization_name: "default",
        active_version_id: activeVersionId,
        deleted: false,
        created_by_id: env.CODER_USER_ID,
      });
    }
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
        provisioner_tags?: Record<string, string>;
      };
      const id = crypto.randomUUID();
      const version = {
        id,
        name: value.name,
        message: value.message,
        organization_id: organizationId,
        ...(value.template_id ? { template_id: value.template_id } : {}),
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
          tags: {
            ...(value.provisioner_tags ?? {
              pool: "synthetic-provisioner-tag",
              scope: "organization",
            }),
            owner: value.provisioner_tags?.scope === "user" ? env.CODER_USER_ID : "",
          },
        },
      };
      versions.set(id, version);
      effects.versions++;
      return mode.endsWith("version_unknown")
        ? new Response(null, { status: 500 })
        : Response.json(version, { status: 201 });
    }
    if (path === `/api/v2/organizations/${organizationId}/templates` && request.method === "POST") {
      const value = (await request.json()) as { name: string; template_version_id: string };
      const version = versions.get(value.template_version_id);
      if (templateExists || !version || value.name !== "ai-dev-k8s")
        return new Response(null, { status: 409 });
      templateExists = true;
      version.template_id = templateId;
      activeVersionId = value.template_version_id;
      effects.templateCreations++;
      return mode === "first_template_unknown"
        ? new Response(null, { status: 500 })
        : Response.json(
            {
              id: templateId,
              name: value.name,
              organization_id: organizationId,
              organization_name: "default",
              active_version_id: activeVersionId,
              created_by_id: env.CODER_USER_ID,
              deleted: false,
            },
            { status: 201 },
          );
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
      const requested = path.split("/").at(-1) ?? "";
      if (requested === priorVersionId)
        return Response.json({
          id: priorVersionId,
          template_id: templateId,
          organization_id: organizationId,
          job: {
            organization_id: organizationId,
            tags: { pool: "synthetic-provisioner-tag", scope: "organization", owner: "" },
          },
        });
      const version = versions.get(requested);
      return version ? Response.json(version) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  },
};
