"use server";

import { authActionClient } from "../safe-action";
import { getAuthServiceClient } from "./service-client";

export const getSessionAction = authActionClient.action(async ({ ctx }) => {
  return {
    user: {
      id: ctx.user.id,
      email: ctx.user.email,
      coderUrl: ctx.user.coderUrl,
    },
  };
});

export const getTokenStatusAction = authActionClient.action(async ({ ctx }) => {
  const result = await getAuthServiceClient().getCredentials(ctx.session.sessionId);
  if (!result) {
    return { status: "expired" as const, expiresAt: null };
  }
  return {
    status: result.status,
    expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
  };
});
