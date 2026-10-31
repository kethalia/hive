// Loopback-only proof fixture. No deployed wrangler config exists for this file.
import { createHash } from "node:crypto";
import {
  type EvidenceR2Bucket,
  R2GitHubArtifactStore,
} from "../../../src/lib/delivery/github-artifacts.server";
import { DeliveryConflict } from "../../../src/lib/delivery/state";

interface Env {
  HIVE_DELIVERY_EVIDENCE: EvidenceR2Bucket & {
    put(key: string, value: Uint8Array): Promise<unknown>;
    list(options: {
      prefix: string;
      limit: number;
    }): Promise<{ objects: unknown[]; truncated: boolean }>;
  };
  LOCAL_PROOF_BEARER: string;
}
export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get("Authorization") !== `Bearer ${env.LOCAL_PROOF_BEARER}`)
      return new Response(null, { status: 403 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const input = (await request.json()) as {
      operation: string;
      caseId: string;
      key?: string;
      contentBase64?: string;
      digest?: string;
    };
    if (input.operation === "artifact") {
      if (
        typeof input.key !== "string" ||
        typeof input.digest !== "string" ||
        typeof input.contentBase64 !== "string" ||
        input.contentBase64.length > 3 * 1024 * 1024
      )
        return new Response(null, { status: 400 });
      try {
        return Response.json(
          await new R2GitHubArtifactStore(env.HIVE_DELIVERY_EVIDENCE).writeAndVerify(
            input.key,
            Buffer.from(input.contentBase64, "base64"),
            input.digest,
          ),
        );
      } catch {
        return Response.json({ error: "artifact_unverified" }, { status: 409 });
      }
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.caseId))
      return new Response(null, { status: 400 });
    const content = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, fixture: input.caseId }),
    );
    const digest = createHash("sha256").update(content).digest("hex");
    const prefix = `delivery/${input.caseId}/github/123/${"a".repeat(40)}/`,
      key = `${prefix}${digest}.json`;
    try {
      if (input.operation === "corrupt") {
        // Explicit adversarial fixture write, outside the production store.
        await env.HIVE_DELIVERY_EVIDENCE.put(key, new Uint8Array(content.length).fill(120));
        return Response.json({ corrupted: true });
      }
      if (input.operation === "inspect") {
        const object = await env.HIVE_DELIVERY_EVIDENCE.get(key),
          listed = await env.HIVE_DELIVERY_EVIDENCE.list({ prefix, limit: 2 });
        return Response.json({
          count: listed.objects.length,
          truncated: listed.truncated,
          digest: object
            ? createHash("sha256")
                .update(new Uint8Array(await new Response(object.body).arrayBuffer()))
                .digest("hex")
            : null,
        });
      }
      if (input.operation !== "store") return new Response(null, { status: 400 });
      const receipt = await new R2GitHubArtifactStore(env.HIVE_DELIVERY_EVIDENCE).writeAndVerify(
        key,
        content,
        digest,
      );
      return Response.json(receipt);
    } catch (error) {
      return Response.json(
        { error: error instanceof DeliveryConflict ? error.code : "local_fixture_failure" },
        { status: 409 },
      );
    }
  },
};
