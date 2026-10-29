// Local-only wrapper. Deployment preparation pins main to app/worker.ts.
import { createHash, createPublicKey } from "node:crypto";
import { registeredSessionConfig } from "../../../src/lib/codex-session/registered-session.server";
import { WorkspaceRegistrationAuthority } from "../../../src/lib/codex-session/registration.server";
import app from "../app/worker";

export default {
  async fetch(
    request: Request,
    env: Parameters<typeof app.fetch>[1] & { PROOF_BEARER?: string },
    context: Parameters<typeof app.fetch>[2],
  ) {
    if (new URL(request.url).pathname !== "/__local-callback-configuration")
      return app.fetch(request, env, context);
    if (!env.PROOF_BEARER || request.headers.get("Authorization") !== `Bearer ${env.PROOF_BEARER}`)
      return new Response(null, { status: 404 });
    const config = registeredSessionConfig();
    const unused = async (): Promise<never> => {
      throw new Error("Local config check does not query authority");
    };
    // Exercise the actual native configuration/crypto constructor without SQL,
    // Coder requests or a production health/test endpoint.
    new WorkspaceRegistrationAuthority(config, {
      store: { reserve: unused, seal: unused, consumeAndRegister: unused },
      coderForPrincipal: unused,
      authorizedProjects: unused,
    });
    const publicKey = createPublicKey(config.privateKeyPem).export({ type: "spki", format: "der" });
    return Response.json({
      configured: true,
      issuerPublicKeySHA256: createHash("sha256").update(publicKey).digest("hex"),
    });
  },
};
