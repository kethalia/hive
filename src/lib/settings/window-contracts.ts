import { z } from "zod";

const text = z
  .string()
  .min(1)
  .max(512)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
export const settingsWindowSchema = z
  .object({
    email: text,
    coderUrl: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
      }),
    connectedWorkspaceIds: z.array(text),
    pendingWorkspaceIds: z.array(text),
    workspaces: z.array(z.object({ id: text, name: text, running: z.boolean() }).strict()),
    workspaceError: z.boolean(),
  })
  .strict();

export type SettingsWindowData = z.infer<typeof settingsWindowSchema>;
export const SETTINGS_UNAVAILABLE = "Settings are unavailable. Refresh and try again.";
