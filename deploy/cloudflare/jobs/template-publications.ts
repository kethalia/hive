import { AuthServiceClient, authServiceHeaders } from "@hive/auth";
import type { getDb } from "@hive/db";
import { publicationActorAuthorizer } from "../../../src/lib/templates/publication-actor";
import {
  type TemplateAssets,
  templateAssetsLoader,
} from "../../../src/lib/templates/publication-artifact";
import {
  cancelPublicationBody,
  publicationBody,
  publicationFetch,
} from "../../../src/lib/templates/publication-io";
import { TemplatePublicationService } from "../../../src/lib/templates/publication-service";

export type TemplatePublicationEnvironment = {
  HIVE_TEMPLATE_PUBLICATION_ENABLED?: string;
  AUTH_SERVICE?: { fetch: typeof fetch };
  AUTH_SERVICE_SECRET?: string;
  ASSETS?: TemplateAssets;
};

/** Only the fixed private service binding receives this credential. Buffer its
 * bounded reply before the auth client parses it; even late streams are cancelled. */
export function publicationAuthClient(env: TemplatePublicationEnvironment) {
  const service = env.AUTH_SERVICE;
  if (!service || typeof service.fetch !== "function")
    throw new Error("Template publication authentication binding unavailable");
  if (typeof env.AUTH_SERVICE_SECRET !== "string")
    throw new Error("Template publication authentication secret unavailable");
  authServiceHeaders(env.AUTH_SERVICE_SECRET);
  return new AuthServiceClient("https://hive-auth.internal", 10000, {
    serviceSecret: env.AUTH_SERVICE_SECRET,
    fetch: async (input, init) => {
      const signal = AbortSignal.any([
        AbortSignal.timeout(10000),
        ...(init?.signal ? [init.signal] : []),
      ]);
      const response = await publicationFetch(service.fetch(input, { ...init, signal }), signal);
      if (response.status === 404) {
        await cancelPublicationBody(response);
        return new Response(null, { status: 404 });
      }
      if (response.status !== 200 || response.redirected) {
        await cancelPublicationBody(response);
        throw new Error("Template publication authentication unavailable");
      }
      const body = await publicationBody(response, 65536, signal);
      return new Response(new Uint8Array(body).buffer, {
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

export async function dispatchTemplatePublication(
  db: ReturnType<typeof getDb>,
  env: TemplatePublicationEnvironment,
) {
  if (env.HIVE_TEMPLATE_PUBLICATION_ENABLED !== "true") return { enabled: false };
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function")
    throw new Error("Template publication artifacts unavailable");
  const service = new TemplatePublicationService(db, {
    enabled: true,
    authorizeActor: publicationActorAuthorizer(publicationAuthClient(env)),
    loadArtifact: templateAssetsLoader(env.ASSETS),
  });
  // One invocation handles one stage, never a whole import or an unbounded queue.
  const result = await service.processOne();
  return {
    enabled: true,
    claimed: result.claimed ? 1 : 0,
    progressed: result.claimed && result.outcome === "progressed" ? 1 : 0,
    heldOrDeferred: result.claimed && result.outcome === "held_or_deferred" ? 1 : 0,
  };
}
