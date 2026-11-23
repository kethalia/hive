import { z } from "zod";
import { appPreviewBuildPath, appPreviewOrigin } from "./app-preview-origin.mjs";

export const appPreviewBuildSchema = z.object({
  branch: z.string().min(1).max(256),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
});

export const appPreviewCatalogSchema = z.array(
  appPreviewBuildSchema.extend({
    slug: z.string().refine((slug) => appPreviewOrigin(slug) !== null),
    number: z.number().int().positive(),
    title: z.string().min(1).max(256),
  }),
);

export type AppPreview = z.infer<typeof appPreviewCatalogSchema>[number];

export async function isAppPreviewDeployed(
  preview: Pick<AppPreview, "slug" | "branch" | "revision">,
  signal?: AbortSignal,
) {
  const origin = appPreviewOrigin(preview.slug);
  if (!origin) return false;
  try {
    const response = await fetch(origin + appPreviewBuildPath, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(3_000)])
        : AbortSignal.timeout(3_000),
    });
    if (!response.ok) return false;
    const build = appPreviewBuildSchema.safeParse(await response.json());
    return (
      build.success &&
      build.data.branch === preview.branch &&
      build.data.revision === preview.revision
    );
  } catch {
    // A missing, older or unreachable preview cannot be opened in Hive.
    return false;
  }
}
