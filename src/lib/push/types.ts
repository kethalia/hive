import { z } from "zod";

export const notificationKindSchema = z.enum([
  "question",
  "approval",
  "ready",
  "failure",
  "token",
  "template",
  "delivery",
]);
export type NotificationKind = z.infer<typeof notificationKindSchema>;
export const notificationPreferencesSchema = z.object({
  question: z.boolean().default(true),
  approval: z.boolean().default(true),
  ready: z.boolean().default(true),
  failure: z.boolean().default(true),
  token: z.boolean().default(true),
  template: z.boolean().default(true),
  delivery: z.boolean().default(true),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export const notificationLabels: Record<NotificationKind, string> = {
  question: "Question waiting",
  approval: "Approval needed",
  ready: "Agent ready",
  failure: "Agent failed (Claude Code)",
  token: "Token expiring",
  template: "Template push result",
  delivery: "Delivery step reports",
};
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  kind?: NotificationKind;
  url?: string;
}
