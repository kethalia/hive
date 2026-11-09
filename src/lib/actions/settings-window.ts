"use server";
import { authActionClient } from "@/lib/safe-action";
import { readSettingsWindow } from "@/lib/settings/window.server";

export const getSettingsWindowAction = authActionClient.action(({ ctx }) =>
  readSettingsWindow(ctx.user),
);
