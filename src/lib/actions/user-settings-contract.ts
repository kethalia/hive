import { z } from "zod";

export const terminalSettingsDtoSchema = z
  .object({
    terminalControlsBeyondMobile: z.boolean(),
  })
  .strict();

export const updateTerminalSettingsSchema = terminalSettingsDtoSchema;

export type TerminalSettingsDto = z.infer<typeof terminalSettingsDtoSchema>;
export type UpdateTerminalSettingsInput = z.infer<typeof updateTerminalSettingsSchema>;

export function isTerminalSettingsDto(value: unknown): value is TerminalSettingsDto {
  return terminalSettingsDtoSchema.safeParse(value).success;
}
