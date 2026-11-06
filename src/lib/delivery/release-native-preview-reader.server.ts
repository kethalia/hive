import { z } from "zod";
import { withReleaseDeadline } from "../../../deploy/cloudflare/app/release-health";
import {
  cancelPublicationBody,
  publicationBody,
  publicationFetch,
} from "../templates/publication-io";
import { githubSourceDigest } from "./github-evidence.server";

// Deployment-owned enrollment, never a model/task-selected URL or branch. This
// foundation supports only the already enrolled native epic Preview.
export const nativePreviewProviderIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .refine((id) => id !== "latest");
export const nativePreviewReleaseTargetSchema = z
  .object({
    provider: z.literal("cloudflare-native-preview"),
    accountId: z.literal("225177f82b9234ede14e897fe15e0cb5"),
    workerName: z.literal("hive"),
    previewId: nativePreviewProviderIdSchema,
    previewName: z.literal("codex/delivery-system-design"),
    previewSlug: z.literal("codex-delivery-system-design"),
    origin: z.literal("https://codex-delivery-system-design-hive.b00ste.workers.dev"),
  })
  .strict();
export type NativePreviewReleaseTarget = z.infer<typeof nativePreviewReleaseTargetSchema>;
const previewSchema = z.object({
  id: nativePreviewProviderIdSchema,
  name: z.string(),
  slug: z.string(),
});
const deploymentSchema = z.object({
  id: nativePreviewProviderIdSchema,
  annotations: z
    .object({
      "workers/commit_sha": z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .optional(),
      "workers/message": z.string().max(1024).optional(),
    })
    .optional(),
});
const envelope = <T extends z.ZodTypeAny>(result: T) =>
  z.object({
    success: z.literal(true),
    result,
    errors: z.array(z.unknown()).length(0).optional(),
  });
export const NATIVE_PREVIEW_IDENTITY_DEADLINE_MS = 10000;
export const NATIVE_PREVIEW_IDENTITY_BODY_BYTES = 65536;

/** Identity readback only: a branch deployment ID is not a parent production
 * version ID, artifact digest, config attestation, health proof or effect receipt.
 * Current release provider/observer guards deliberately remain unchanged. */
export class NativePreviewReleaseReader {
  private readonly target: NativePreviewReleaseTarget;
  constructor(
    rawTarget: unknown,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    try {
      this.target = nativePreviewReleaseTargetSchema.parse(rawTarget);
      if (!/^[!-~]{1,4096}$/.test(token)) throw Error();
    } catch {
      throw Error("release_native_preview_unavailable");
    }
  }
  async readCurrent(parent: AbortSignal) {
    try {
      return await withReleaseDeadline(
        async (signal) => {
          const t = this.target;
          const root = `https://api.cloudflare.com/client/v4/accounts/${t.accountId}/workers/workers/${t.workerName}/previews`;
          const get = async <T extends z.ZodTypeAny>(
            path: string,
            schema: T,
          ): Promise<z.infer<T>> => {
            signal.throwIfAborted();
            const response = await publicationFetch(
              Promise.resolve().then(() =>
                this.fetcher(`${root}/${path}`, {
                  method: "GET",
                  redirect: "manual",
                  credentials: "omit",
                  signal,
                  headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
                }),
              ),
              signal,
            );
            if (response.status !== 200 || response.redirected) {
              await cancelPublicationBody(response);
              throw Error();
            }
            return envelope(schema).parse(
              JSON.parse(
                Buffer.from(
                  await publicationBody(response, NATIVE_PREVIEW_IDENTITY_BODY_BYTES, signal),
                ).toString("utf8"),
              ),
            ).result;
          };
          const sample = async () => {
            // Resolve the exact branch name, then address the pinned immutable
            // Preview ID. Deletion/recreation under the same name must hold.
            const preview = await get(encodeURIComponent(t.previewName), previewSchema);
            if (
              preview.id !== t.previewId ||
              preview.name !== t.previewName ||
              preview.slug !== t.previewSlug
            )
              throw Error();
            const deployment = await get(
              `${encodeURIComponent(t.previewId)}/deployments/latest`,
              deploymentSchema,
            );
            const marker = deployment.annotations?.["workers/message"]?.match(
              /^hive-release:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/,
            );
            return {
              scope: "native-preview-current-identity" as const,
              targetDigest: githubSourceDigest(t),
              previewId: preview.id,
              previewName: preview.name,
              previewSlug: preview.slug,
              origin: t.origin,
              deploymentId: deployment.id,
              annotatedSourceSha: deployment.annotations?.["workers/commit_sha"] ?? null,
              annotatedActionId: marker?.[1] ?? null,
            };
          };
          const first = await sample(),
            second = await sample();
          signal.throwIfAborted();
          if (githubSourceDigest(first) !== githubSourceDigest(second)) throw Error();
          return second;
        },
        parent,
        NATIVE_PREVIEW_IDENTITY_DEADLINE_MS,
      );
    } catch {
      // Provider payloads may contain environment values/secrets; no provider
      // errors, arbitrary annotations, raw JSON or credential hashes escape.
      throw Error("release_native_preview_identity_hold");
    }
  }
}
