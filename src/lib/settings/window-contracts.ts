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
export const coderConnectionSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("oauth"),
      credentialId: z.string().uuid(),
      version: z.number().int().positive(),
      status: z.enum(["connected", "reconnect"]),
    })
    .strict(),
  z.object({ source: z.literal("other") }).strict(),
]);
export const coderDisconnectRequestSchema = z
  .object({ credentialId: z.string().uuid(), version: z.number().int().positive().max(2147483646) })
  .strict();
export const coderDisconnectResultSchema = z
  .object({
    status: z.literal("disconnected"),
    providerRevocation: z.enum(["acknowledged", "unconfirmed"]),
    currentConnection: z.enum(["disconnected", "changed", "unknown"]),
  })
  .strict();
export type CoderConnection = z.infer<typeof coderConnectionSchema>;
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
    coderConnection: coderConnectionSchema.default({ source: "other" }),
  })
  .strict();

export type SettingsWindowData = z.infer<typeof settingsWindowSchema>;
export const SETTINGS_UNAVAILABLE = "Settings are unavailable. Refresh and try again.";
