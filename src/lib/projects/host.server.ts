import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { postToVerifiedWorkspaceApp } from "@/lib/codex-session/bootstrap-delivery.server";
import { registeredSessionConfig } from "@/lib/codex-session/registered-session.server";
import { resolveVerifiedWorkspaceHost } from "@/lib/codex-session/registration.server";
import { projectErrorCodeSchema, projectPageSchema, projectRequestSchema } from "./contracts";
import { ProjectDiscoveryError } from "./errors";

if (typeof window !== "undefined") throw new Error("Project host discovery is server-only");
export async function discoverHostProjects(
  user: { id: string; coderUserId: string },
  value: unknown,
) {
  const request = projectRequestSchema.parse(value);
  try {
    const config = registeredSessionConfig();
    const client = await getCoderClientForUser(user.id);
    const { binding } = await resolveVerifiedWorkspaceHost(
      config,
      async () => client,
      { hiveUserId: user.id, coderUserId: user.coderUserId },
      request.workspaceId,
    );
    const key = createPrivateKey(config.privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Unsupported issuer key");
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: config.hiveOrigin,
      aud: binding.appOrigin,
      scope: "projects:discover",
      jti: randomUUID(),
      iat,
      exp: iat + 45,
      binding,
      request: { schemaVersion: 1, page: request.page, perPage: request.perPage },
    };
    const encoded = [{ alg: "EdDSA", typ: "JWT", kid: config.keyId }, claims]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    const ticket = `${encoded}.${sign(null, Buffer.from(encoded), key).toString("base64url")}`;
    const reply = await postToVerifiedWorkspaceApp(client, binding, {
      path: "/projects/discover",
      body: JSON.stringify({ ticket }),
      expiresAt: claims.exp,
    });
    const current = await client.getWorkspace(request.workspaceId);
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
    const page = projectPageSchema.safeParse(reply);
    if (!page.success || page.data.page !== request.page || page.data.perPage !== request.perPage)
      throw new ProjectDiscoveryError("github_invalid_response");
    return page.data;
  } catch (error) {
    if (error instanceof ProjectDiscoveryError) throw error;
    throw new ProjectDiscoveryError("discovery_unavailable");
  }
}
