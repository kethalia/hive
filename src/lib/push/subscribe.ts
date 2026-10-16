"use server";

import { getDb } from "@hive/db";
import { z } from "zod";
import { authActionClient } from "../safe-action";
import { notificationPreferencesSchema } from "./types";

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
});

export const subscribePushAction = authActionClient
  .inputSchema(subscribeSchema)
  .action(async ({ parsedInput: { endpoint, p256dh, auth }, ctx }) => {
    const db = getDb();
    // A browser endpoint belongs to the account currently using this device.
    // Remove a prior account association before saving it for the signed-in user.
    await db.pushSubscription.deleteMany({ where: { endpoint, userId: { not: ctx.user.id } } });
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
      `[push] Subscription upserted for user ${ctx.user.id} endpoint ${new URL(endpoint).hostname}`,
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
      `[push] Subscription removed for user ${ctx.user.id} endpoint ${new URL(endpoint).hostname}`,
    );
    return { success: true as const };
  });

export const getPushPreferencesAction = authActionClient
  .inputSchema(unsubscribeSchema)
  .action(async ({ parsedInput: { endpoint }, ctx }) => {
    const subscription = await getDb().pushSubscription.findUnique({
      where: { userId_endpoint: { userId: ctx.user.id, endpoint } },
    });
    return notificationPreferencesSchema.parse(subscription?.preferences ?? {});
  });

export const updatePushPreferencesAction = authActionClient
  .inputSchema(z.object({ endpoint: z.string().url(), preferences: notificationPreferencesSchema }))
  .action(async ({ parsedInput: { endpoint, preferences }, ctx }) => {
    await getDb().pushSubscription.update({
      where: { userId_endpoint: { userId: ctx.user.id, endpoint } },
      data: { preferences },
    });
    return { success: true as const };
  });
