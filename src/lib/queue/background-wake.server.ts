import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";

export type BackgroundBinding = {
  getByName(name: string): { wake(ownerId: string, notBefore?: number): Promise<void> };
};
export async function wakeBackground(
  env: { BACKGROUND: BackgroundBinding; HIVE_DATABASE_NAME?: string },
  ownerId: string,
) {
  z.string().uuid().parse(ownerId);
  if (!env.HIVE_DATABASE_NAME) throw new Error("Background database unavailable");
  await env.BACKGROUND.getByName(`${env.HIVE_DATABASE_NAME}:${ownerId}`).wake(ownerId);
}
export async function wakeCloudflareBackground(ownerId: string) {
  const { env } = getCloudflareContext();
  await wakeBackground(
    env as unknown as {
      BACKGROUND: BackgroundBinding;
      HIVE_DATABASE_NAME: string;
    },
    ownerId,
  );
}
