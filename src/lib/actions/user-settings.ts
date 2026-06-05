"use server";

import { getDb } from "@hive/db";
import { authActionClient } from "@/lib/safe-action";
import {
  type TerminalSettingsDto,
  terminalSettingsDtoSchema,
  updateTerminalSettingsSchema,
} from "./user-settings-contract";

const TERMINAL_SETTINGS_UNAVAILABLE_MESSAGE =
  "Terminal settings are unavailable. Refresh and try again.";

export const getTerminalSettingsAction = authActionClient.action(
  async ({ ctx }): Promise<TerminalSettingsDto> => {
    try {
      const db = getDb();
      const row = await db.user.findUnique({
        where: { id: ctx.user.id },
        select: { terminalControlsBeyondMobile: true },
      });

      return serializeTerminalSettings(row);
    } catch (error) {
      logTerminalSettingsError("get", error);
      throw new Error(TERMINAL_SETTINGS_UNAVAILABLE_MESSAGE);
    }
  },
);

export const updateTerminalSettingsAction = authActionClient
  .inputSchema(updateTerminalSettingsSchema)
  .action(async ({ parsedInput, ctx }): Promise<TerminalSettingsDto> => {
    try {
      const db = getDb();
      const row = await db.user.update({
        where: { id: ctx.user.id },
        data: {
          terminalControlsBeyondMobile: parsedInput.terminalControlsBeyondMobile,
        },
        select: { terminalControlsBeyondMobile: true },
      });

      return terminalSettingsDtoSchema.parse(row);
    } catch (error) {
      logTerminalSettingsError("update", error);
      throw new Error(TERMINAL_SETTINGS_UNAVAILABLE_MESSAGE);
    }
  });

function serializeTerminalSettings(row: unknown): TerminalSettingsDto {
  const parsed = terminalSettingsDtoSchema.safeParse(row);
  if (parsed.success) {
    return parsed.data;
  }

  return { terminalControlsBeyondMobile: false };
}

function logTerminalSettingsError(operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.name : typeof error;
  console.error(`[user-settings] terminal ${operation} failed (${reason})`);
}
