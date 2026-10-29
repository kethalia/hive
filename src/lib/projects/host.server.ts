import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { postToVerifiedWorkspaceApp } from "@/lib/codex-session/bootstrap-delivery.server";
import { registeredSessionConfig } from "@/lib/codex-session/registered-session.server";
import { resolveVerifiedWorkspaceHost } from "@/lib/codex-session/registration.server";
import { projectErrorCodeSchema, projectPageSchema, projectRequestSchema } from "./contracts";
import { ProjectDiscoveryError } from "./errors";

if (typeof window !== "undefined") throw new Error("Project host discovery is server-only");
export type ProjectPrincipal = { id: string; coderUserId: string };
const endpoints = {
  "/projects/discover": "projects:discover",
  "/projects/resolve": "projects:resolve",
  "/projects/open": "projects:open",
  "/projects/tasks/start": "projects:task:start",
  "/projects/tasks/status": "projects:task:read",
  "/projects/tasks/retry": "projects:task:retry",
} as const;
/** Internal controller only. The endpoint and scope pair is fixed here; browser
 * inputs are parsed by each operation before reaching this signer. */
export async function signedHostProjectRequest(
  user: ProjectPrincipal,
  workspaceId: string,
  path: keyof typeof endpoints,
  request: Record<string, unknown>,
) {
  try {
    const config = registeredSessionConfig();
    const client = await getCoderClientForUser(user.id);
    const { binding } = await resolveVerifiedWorkspaceHost(
      config,
      async () => client,
      { hiveUserId: user.id, coderUserId: user.coderUserId },
      workspaceId,
    );
    const key = createPrivateKey(config.privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Unsupported issuer key");
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: config.hiveOrigin,
      aud: binding.appOrigin,
      scope: endpoints[path],
      jti: randomUUID(),
      iat,
      exp: iat + 45,
      binding,
      request,
    };
    const encoded = [{ alg: "EdDSA", typ: "JWT", kid: config.keyId }, claims]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    const ticket = `${encoded}.${sign(null, Buffer.from(encoded), key).toString("base64url")}`;
    const reply = await postToVerifiedWorkspaceApp(client, binding, {
      path,
      body: JSON.stringify({ ticket }),
      expiresAt: claims.exp,
    });
    const current = await client.getWorkspace(workspaceId);
    if (
      current.id !== binding.workspaceId ||
      current.owner_id !== user.coderUserId ||
      current.latest_build.id !== binding.buildId ||
      current.latest_build.status !== "running"
    )
      throw new ProjectDiscoveryError("workspace_unavailable");
    if (
      reply &&
      typeof reply === "object" &&
      "schemaVersion" in reply &&
      reply.schemaVersion === 1 &&
      "error" in reply
    ) {
      const code = projectErrorCodeSchema.safeParse(reply.error);
      if (code.success) throw new ProjectDiscoveryError(code.data);
    }
    return reply;
  } catch (error) {
    if (error instanceof ProjectDiscoveryError) throw error;
    throw new ProjectDiscoveryError("discovery_unavailable");
  }
}

export async function discoverHostProjects(user: ProjectPrincipal, value: unknown) {
  const request = projectRequestSchema.parse(value);
  const reply = await signedHostProjectRequest(user, request.workspaceId, "/projects/discover", {
    schemaVersion: 1,
    page: request.page,
    perPage: request.perPage,
  });
  const page = projectPageSchema.safeParse(reply);
  if (!page.success || page.data.page !== request.page || page.data.perPage !== request.perPage)
    throw new ProjectDiscoveryError("github_invalid_response");
  return page.data;
}
