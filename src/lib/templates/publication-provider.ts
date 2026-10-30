import { createHash } from "node:crypto";
import { getConfiguredCoderUrl, isConfiguredCoderUrl } from "@hive/auth";
import { z } from "zod";
import {
  PUBLICATION_LIMITS,
  type TemplateArtifactIdentity,
  type TemplatePublicationActor,
  TemplatePublicationError,
  type TemplateRemoteTarget,
  type TemplateRemoteVersion,
} from "./publication-contracts";
import { cancelPublicationBody, publicationBody, publicationFetch } from "./publication-io";

const uuid = z.string().uuid();
const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const targetSchema = z.object({
  id: uuid,
  name: slug,
  organization_id: uuid,
  organization_name: slug,
  active_version_id: uuid,
  deleted: z.boolean(),
});
const versionSchema = z.object({
  id: uuid,
  name: slug,
  organization_id: uuid,
  template_id: uuid,
  message: z.string().max(512),
  created_by: z.object({ id: uuid }),
  archived: z.boolean(),
  job: z.object({
    id: uuid,
    organization_id: uuid,
    initiator_id: uuid,
    file_id: uuid,
    type: z.literal("template_version_import"),
    status: z.enum(["pending", "running", "succeeded", "failed", "canceling", "canceled"]),
    error_code: z.string().max(80).nullable().optional(),
    logs_overflowed: z.boolean().optional(),
  }),
});
export interface TemplatePublicationProvider {
  readonly actor: TemplatePublicationActor;
  locate(name: string): Promise<TemplateRemoteTarget>;
  current(target: TemplateRemoteTarget): Promise<TemplateRemoteTarget>;
  upload(bytes: Uint8Array): Promise<string>;
  verifyFile(fileId: string, identity: TemplateArtifactIdentity): Promise<void>;
  versionByName(target: TemplateRemoteTarget, name: string): Promise<TemplateRemoteVersion | null>;
  versionById(target: TemplateRemoteTarget, versionId: string): Promise<TemplateRemoteVersion>;
  createVersion(
    target: TemplateRemoteTarget,
    input: { name: string; message: string; fileId: string },
  ): Promise<TemplateRemoteVersion>;
  logs(
    versionId: string,
    after: string,
  ): Promise<{ after: string; records: number; overflowed: boolean }>;
  activate(target: TemplateRemoteTarget, versionId: string): Promise<void>;
}

/** Captures one verified actor credential per bounded step. No credential refresh
 * inside the provider and no caller-controlled base URL or generic request API. */
export class CoderTemplatePublicationProvider implements TemplatePublicationProvider {
  private constructor(
    readonly actor: TemplatePublicationActor,
    private readonly fetcher: typeof fetch,
    private readonly signal?: AbortSignal,
  ) {}
  static async create(
    actor: TemplatePublicationActor,
    fetcher: typeof fetch = fetch,
    signal?: AbortSignal,
  ) {
    if (
      !isConfiguredCoderUrl(actor.origin) ||
      actor.origin !== getConfiguredCoderUrl() ||
      !uuid.safeParse(actor.coderUserId).success ||
      !uuid.safeParse(actor.ownerId).success ||
      !uuid.safeParse(actor.sessionId).success ||
      typeof actor.token !== "string" ||
      !actor.token ||
      !Number.isFinite(actor.sessionExpiresAt.getTime()) ||
      (actor.tokenExpiresAt !== null && !Number.isFinite(actor.tokenExpiresAt.getTime())) ||
      actor.token.length > 4096
    )
      throw new TemplatePublicationError("actor_revoked");
    const provider = new CoderTemplatePublicationProvider(structuredClone(actor), fetcher, signal);
    const me = z.object({ id: uuid }).parse(await provider.json("GET", "/api/v2/users/me"));
    if (me.id !== actor.coderUserId)
      throw new TemplatePublicationError("provider_identity_mismatch");
    return provider;
  }
  private live() {
    if (
      this.actor.sessionExpiresAt.getTime() <= Date.now() ||
      (this.actor.tokenExpiresAt && this.actor.tokenExpiresAt.getTime() <= Date.now()) ||
      !isConfiguredCoderUrl(this.actor.origin)
    )
      throw new TemplatePublicationError("actor_revoked");
    this.signal?.throwIfAborted();
  }
  private async response(
    method: string,
    path: string,
    body?: BodyInit,
    contentType = "application/json",
    optional = false,
  ) {
    this.live();
    const signal = AbortSignal.any([
      AbortSignal.timeout(PUBLICATION_LIMITS.requestMs),
      ...(this.signal ? [this.signal] : []),
    ]);
    let response: Response;
    try {
      response = await publicationFetch(
        this.fetcher(this.actor.origin + path, {
          method,
          redirect: "manual",
          credentials: "omit",
          headers: {
            "Coder-Session-Token": this.actor.token,
            "Content-Type": contentType,
            "Accept-Encoding": "identity",
          },
          ...(body ? { body } : {}),
          signal,
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof TemplatePublicationError) throw error;
      throw new TemplatePublicationError("provider_unavailable");
    }
    try {
      this.live();
    } catch (error) {
      await cancelPublicationBody(response);
      throw error;
    }
    if (optional && response.status === 404) {
      await cancelPublicationBody(response);
      return { response: null, signal };
    }
    if (response.status < 200 || response.status >= 300) {
      await cancelPublicationBody(response);
      throw new TemplatePublicationError(
        [401, 403].includes(response.status)
          ? "actor_revoked"
          : response.status >= 300 && response.status < 400
            ? "provider_redirect"
            : "provider_unavailable",
      );
    }
    return { response, signal };
  }
  private async json(
    method: string,
    path: string,
    body?: unknown,
    optional = false,
  ): Promise<unknown> {
    const { response, signal } = await this.response(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      "application/json",
      optional,
    );
    if (!response) return null;
    const bytes = await publicationBody(response, PUBLICATION_LIMITS.jsonBytes, signal);
    this.live();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new TemplatePublicationError("provider_identity_mismatch");
    }
  }
  private target(value: unknown): TemplateRemoteTarget {
    const t = targetSchema.parse(value);
    if (t.deleted) throw new TemplatePublicationError("missing_template");
    return {
      organizationId: t.organization_id,
      organizationName: t.organization_name,
      templateId: t.id,
      name: t.name,
      activeVersionId: t.active_version_id,
    };
  }
  private async permission(target: TemplateRemoteTarget) {
    const result = z.object({ publish: z.boolean() }).parse(
      await this.json("POST", "/api/v2/authcheck", {
        checks: {
          publish: {
            action: "update",
            object: {
              resource_type: "template",
              resource_id: target.templateId,
              organization_id: target.organizationId,
            },
          },
        },
      }),
    );
    if (!result.publish) throw new TemplatePublicationError("actor_revoked");
  }
  async locate(name: string) {
    const organization = z
      .object({ id: uuid, name: slug })
      .parse(await this.json("GET", "/api/v2/organizations/default"));
    const raw = await this.json(
      "GET",
      `/api/v2/organizations/${organization.id}/templates/${encodeURIComponent(name)}`,
      undefined,
      true,
    );
    if (!raw) throw new TemplatePublicationError("missing_template");
    const target = this.target(raw);
    if (
      target.name !== name ||
      target.organizationId !== organization.id ||
      target.organizationName !== organization.name
    )
      throw new TemplatePublicationError("provider_identity_mismatch");
    await this.permission(target);
    return target;
  }
  async current(expected: TemplateRemoteTarget) {
    const t = this.target(
      await this.json("GET", `/api/v2/templates/${uuid.parse(expected.templateId)}`),
    );
    if (
      t.templateId !== expected.templateId ||
      t.organizationId !== expected.organizationId ||
      t.organizationName !== expected.organizationName ||
      t.name !== expected.name
    )
      throw new TemplatePublicationError("provider_identity_mismatch");
    await this.permission(t);
    return t;
  }
  async upload(bytes: Uint8Array) {
    if (!bytes.byteLength || bytes.byteLength > PUBLICATION_LIMITS.artifactBytes)
      throw new TemplatePublicationError("artifact_changed");
    const { response, signal } = await this.response(
      "POST",
      "/api/v2/files",
      new Uint8Array(bytes),
      "application/x-tar",
    );
    if (!response) throw new TemplatePublicationError("provider_identity_mismatch");
    const raw = await publicationBody(response, PUBLICATION_LIMITS.jsonBytes, signal);
    const result = z.object({ hash: uuid }).parse(JSON.parse(new TextDecoder().decode(raw)));
    this.live();
    return result.hash;
  }
  async verifyFile(fileId: string, identity: TemplateArtifactIdentity) {
    const { response, signal } = await this.response("GET", `/api/v2/files/${uuid.parse(fileId)}`);
    if (!response) throw new TemplatePublicationError("provider_identity_mismatch");
    const bytes = await publicationBody(response, identity.archiveBytes, signal);
    if (
      bytes.byteLength !== identity.archiveBytes ||
      createHash("sha256").update(bytes).digest("hex") !== identity.archiveDigest
    )
      throw new TemplatePublicationError("provider_identity_mismatch");
    this.live();
  }
  private version(value: unknown, target: TemplateRemoteTarget): TemplateRemoteVersion {
    const v = versionSchema.parse(value);
    if (
      v.archived ||
      v.template_id !== target.templateId ||
      v.organization_id !== target.organizationId ||
      v.job.organization_id !== target.organizationId ||
      v.created_by.id !== this.actor.coderUserId ||
      v.job.initiator_id !== this.actor.coderUserId
    )
      throw new TemplatePublicationError("provider_identity_mismatch");
    return {
      id: v.id,
      name: v.name,
      organizationId: v.organization_id,
      templateId: v.template_id,
      fileId: v.job.file_id,
      importJobId: v.job.id,
      creatorId: v.created_by.id,
      initiatorId: v.job.initiator_id,
      message: v.message,
      status: v.job.status,
      errorCode: v.job.error_code ?? null,
      logsOverflowed: v.job.logs_overflowed ?? false,
    };
  }
  async versionByName(target: TemplateRemoteTarget, name: string) {
    const raw = await this.json(
      "GET",
      `/api/v2/templates/${uuid.parse(target.templateId)}/versions/${slug.parse(name)}`,
      undefined,
      true,
    );
    return raw ? this.version(raw, target) : null;
  }
  async versionById(target: TemplateRemoteTarget, id: string) {
    return this.version(
      await this.json("GET", `/api/v2/templateversions/${uuid.parse(id)}`),
      target,
    );
  }
  async createVersion(
    target: TemplateRemoteTarget,
    input: { name: string; message: string; fileId: string },
  ) {
    return this.version(
      await this.json(
        "POST",
        `/api/v2/organizations/${uuid.parse(target.organizationId)}/templateversions`,
        {
          name: slug.parse(input.name),
          message: input.message,
          template_id: target.templateId,
          storage_method: "file",
          file_id: uuid.parse(input.fileId),
          provisioner: "terraform",
          user_variable_values: [],
        },
      ),
      target,
    );
  }
  async logs(versionId: string, after: string) {
    if (!/^[0-9]{1,20}$/.test(after) || BigInt(after) > BigInt("9223372036854775807"))
      throw new TemplatePublicationError("invalid_request");
    const raw = await this.json(
      "GET",
      `/api/v2/templateversions/${uuid.parse(versionId)}/logs?after=${after}`,
    );
    if (Array.isArray(raw) && raw.length > PUBLICATION_LIMITS.logRecords)
      throw new TemplatePublicationError("provider_response_limit");
    const rows = z
      .array(z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }))
      .max(PUBLICATION_LIMITS.logRecords)
      .parse(raw);
    let next = BigInt(after);
    for (const row of rows) {
      if (BigInt(row.id) <= next) throw new TemplatePublicationError("provider_identity_mismatch");
      next = BigInt(row.id);
    }
    return { after: next.toString(), records: rows.length, overflowed: false };
  }
  async activate(target: TemplateRemoteTarget, versionId: string) {
    await this.json("PATCH", `/api/v2/templates/${uuid.parse(target.templateId)}/versions`, {
      id: uuid.parse(versionId),
    });
  }
}
