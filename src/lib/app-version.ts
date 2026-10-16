import { z } from "zod";

export const appVersionSchema = z.object({
  version: z.string().min(1).max(120),
  buildId: z.string().min(1).max(120),
});

export type AppVersion = z.infer<typeof appVersionSchema>;

// Next embeds these values in both the browser bundle and the server at build time.
// Keep the loaded bundle's identity even when a newer server is deployed.
export const APP_VERSION: AppVersion = {
  version: process.env.NEXT_PUBLIC_HIVE_APP_VERSION ?? "development",
  buildId: process.env.NEXT_PUBLIC_HIVE_APP_BUILD ?? "development",
};

export function hasAppUpdate(current: AppVersion, deployed: AppVersion) {
  return current.version !== deployed.version || current.buildId !== deployed.buildId;
}
