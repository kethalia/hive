"use server";

import { authActionClient } from "../safe-action";
import { getVapidPublicKey } from "./vapid";

export const getVapidPublicKeyAction = authActionClient.action(async () => {
  const publicKey = await getVapidPublicKey();
  return { publicKey };
});
