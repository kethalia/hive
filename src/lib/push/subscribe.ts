"use server";

import { z } from "zod";
import { authActionClient } from "../safe-action";
import { getDb } from "@/lib/db";

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
});

export const subscribePushAction = authActionClient
  .inputSchema(subscribeSchema)
  .action(async ({ parsedInput: { endpoint, p256dh, auth }, ctx }) => {
    const db = getDb();
    await db.pushSubscription.upsert({
      where: {
        userId_endpoint: {
          userId: ctx.user.id,
          endpoint,
        },
      },
      update: { p256dh, auth },
      create: {
        userId: ctx.user.id,
        endpoint,
        p256dh,
        auth,
      },
    });
    console.log(
      `[push] Subscription upserted for user ${ctx.user.id} endpoint ${new URL(endpoint).hostname}`
    );
    return { success: true as const };
  });

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export const unsubscribePushAction = authActionClient
  .inputSchema(unsubscribeSchema)
  .action(async ({ parsedInput: { endpoint }, ctx }) => {
    const db = getDb();
    await db.pushSubscription.deleteMany({
      where: {
        userId: ctx.user.id,
        endpoint,
      },
    });
    console.log(
      `[push] Subscription removed for user ${ctx.user.id} endpoint ${new URL(endpoint).hostname}`
    );
    return { success: true as const };
  });
