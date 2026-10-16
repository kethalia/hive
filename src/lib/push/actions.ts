"use server";

import { getDb } from "@hive/db";
import { z } from "zod";
import { authActionClient } from "../safe-action";
import { sendPushToUser } from "./send";
import { getVapidPublicKey } from "./vapid";

export const getVapidPublicKeyAction = authActionClient.action(async () => {
  const publicKey = await getVapidPublicKey();
  return { publicKey };
});

export const testPushAction = authActionClient
  .inputSchema(z.object({ endpoint: z.string().url() }))
  .action(async ({ parsedInput: { endpoint }, ctx }) => {
    const subscription = await getDb().pushSubscription.findUnique({
      where: { userId_endpoint: { userId: ctx.user.id, endpoint } },
    });
    if (!subscription) throw new Error("Enable notifications on this device first");
    // Send only to the device being tested, without changing its preferences.
    return sendPushToUser(
      ctx.user.id,
      {
        title: "Test notification",
        body: "This device can receive push notifications.",
        tag: "hive-test",
        url: "/settings#notifications",
      },
      false,
      endpoint,
    );
  });
