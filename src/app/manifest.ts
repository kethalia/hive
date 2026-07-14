import type { MetadataRoute } from "next";

/**
 * Web App Manifest for Hive.
 *
 * All paths are kept relative (no absolute https URLs) so the PWA installs
 * correctly when served behind Coder's per-workspace reverse proxy where the
 * external origin is unknown at build time.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Hive",
    short_name: "Hive",
    description:
      "Hive is a developer orchestrator for managing workspaces, tasks, and agents from any device.",
    start_url: "/workspaces",
    scope: "/",
    display: "standalone",
    orientation: "any",
    theme_color: "#09090b",
    background_color: "#09090b",
    lang: "en",
    dir: "ltr",
    categories: ["developer", "productivity"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
