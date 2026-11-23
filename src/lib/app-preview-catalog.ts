import { z } from "zod";
import { appPreviewOrigin } from "./app-preview-origin.mjs";

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
