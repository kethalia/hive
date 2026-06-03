import { z } from "zod";

export const terminalSettingsDtoSchema = z
  .object({
    terminalControlsBeyondMobile: z.boolean(),
  })
  .strict();

export const updateTerminalSettingsSchema = terminalSettingsDtoSchema;

export type TerminalSettingsDto = z.infer<typeof terminalSettingsDtoSchema>;
export type UpdateTerminalSettingsInput = z.infer<typeof updateTerminalSettingsSchema>;
