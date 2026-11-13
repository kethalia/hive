import { z } from "zod";
import { KNOWN_TEMPLATES } from "./catalog";

export const publicationNameSchema = z
  .string()
  .refine((v) => (KNOWN_TEMPLATES as readonly string[]).includes(v));
export const publicationStageSchema = z.enum([
  "queued",
  "uploading",
  "creating_version",
  "creating_template",
  "importing",
  "activating",
  "succeeded",
  "failed",
  "held",
]);
export const publicationReasonSchema = z.enum([
  "publication_disabled",
  "publication_busy",
  "publication_not_found",
  "invalid_request",
  "actor_revoked",
  "missing_template",
  "artifact_unavailable",
  "artifact_changed",
  "provider_unavailable",
  "provider_redirect",
  "provider_identity_mismatch",
  "provider_response_limit",
  "provider_deadline",
  "version_unknown",
  "template_creation_unknown",
  "provisioner_tags_changed",
  "activation_unknown",
  "external_drift",
  "import_failed",
  "import_timeout",
  "lease_lost",
  "progress_limit",
  "request_conflict",
]);
export type PublicationReason = z.infer<typeof publicationReasonSchema>;
export class TemplatePublicationError extends Error {
  constructor(readonly code: PublicationReason) {
    super(code);
  }
}
export const PUBLICATION_LIMITS = {
  artifactBytes: 1048576,
  jsonBytes: 262144,
  requestMs: 10000,
  invocationMs: 60000,
  leaseMs: 90000,
  events: 256,
  eventPage: 100,
  logRecords: 1000,
  retries: 5,
  importMs: 15 * 60_000,
} as const;
export type TemplateArtifactIdentity = {
  name: string;
  contentHash: string;
  archiveDigest: string;
  archiveBytes: number;
  manifestDigest: string;
};
export type TemplatePublicationActor = {
  ownerId: string;
  coderUserId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  origin: string;
  token: string;
  tokenExpiresAt: Date | null;
};
export type TemplateRemoteTarget = {
  organizationId: string;
  organizationName: string;
  templateId: string | null;
  name: string;
  activeVersionId: string | null;
  createdById?: string;
};
export type TemplateRemoteVersion = {
  id: string;
  name: string;
  organizationId: string;
  templateId: string | null;
  fileId: string;
  importJobId: string;
  creatorId: string;
  initiatorId: string;
  message: string;
  status: "pending" | "running" | "succeeded" | "failed" | "canceling" | "canceled";
  errorCode: string | null;
  logsOverflowed: boolean;
  /** Ephemeral API observation; never stored in progress or job records. */
  provisionerTags?: Record<string, string>;
};
export const publicationCodeSchema = z.enum([
  "queued",
  "upload_started",
  "upload_verified",
  "version_started",
  "version_verified",
  "template_create_started",
  "template_created",
  "import_pending",
  "import_running",
  "import_succeeded",
  "import_failed",
  "log_metadata",
  "log_limit",
  "activation_started",
  "activation_verified",
  "held",
  "failed",
]);
export type PublicationCode = z.infer<typeof publicationCodeSchema>;
export const publicationEventDataSchema = z
  .object({
    status: z
      .enum(["pending", "running", "succeeded", "failed", "canceling", "canceled"])
      .optional(),
    records: z.number().int().min(0).max(PUBLICATION_LIMITS.logRecords).optional(),
    after: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .optional(),
    reason: publicationReasonSchema.optional(),
  })
  .strict();
export const publicationLabels: Record<PublicationCode, string> = {
  queued: "Publication queued",
  upload_started: "Uploading verified template artifact",
  upload_verified: "Uploaded artifact verified",
  version_started: "Creating template version",
  version_verified: "Template version identity verified",
  template_create_started: "Creating template from verified initial version",
  template_created: "Template created and initial version active",
  import_pending: "Template import queued",
  import_running: "Template import running",
  import_succeeded: "Template import succeeded",
  import_failed: "Template import failed",
  log_metadata: "Provisioner log progress recorded; detailed output is available in Coder",
  log_limit: "Provisioner log preview is bounded; detailed output is available in Coder",
  activation_started: "Activating verified template version",
  activation_verified: "Template published",
  held: "Publication held for review",
  failed: "Publication failed",
};
