import { z } from "zod";
import { appPreviewOrigin } from "./app-preview-origin.mjs";

export const appPreviewCatalogSchema = z.array(
  z.object({
    slug: z.string().refine((slug) => appPreviewOrigin(slug) !== null),
    number: z.number().int().positive(),
    title: z.string().min(1).max(256),
    branch: z.string().min(1).max(256),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
  }),
);
