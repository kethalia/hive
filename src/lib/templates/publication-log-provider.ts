import { getConfiguredCoderUrl } from "@hive/auth";
import { z } from "zod";
import type { TemplatePublicationActor } from "./publication-contracts";
import { cancelPublicationBody, publicationBody, publicationFetch } from "./publication-io";
import {
  TEMPLATE_LOG_LIMITS,
  type TemplateLogPage,
  templateLogCursorSchema,
} from "./publication-log-contracts";
import { readTemplateLogArray } from "./publication-log-reader";

export class TemplateLogAccessError extends Error {
  constructor(readonly code: "actor_revoked" | "not_found" | "identity_changed" | "unavailable") {
    super(code);
  }
}
export type PublicationLogBinding = {
  organizationId: string;
  templateId: string | null;
  operationMode: string;
  stage: string;
  versionId: string;
  fileId: string;
  importJobId: string;
  versionName: string;
  message: string;
  actorCoderUserId: string;
};
const uuid = z.string().uuid();
const versionSchema = z.object({
  id: uuid,
  template_id: uuid.nullish(),
  organization_id: uuid,
  name: z.string(),
  message: z.string(),
  created_by: z.object({ id: uuid }),
  job: z.object({
    id: uuid,
    file_id: uuid,
    organization_id: uuid,
    initiator_id: uuid,
    type: z.literal("template_version_import"),
  }),
});

/** Fixed GET-only capability. Human log reads cannot upload, mutate or select
 * a provider URL. Each call retains one subject-verified captured credential. */
export async function readPublicationLogPage(
  actor: TemplatePublicationActor,
  binding: PublicationLogBinding,
  after: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<TemplateLogPage> {
  const origin = getConfiguredCoderUrl();
  templateLogCursorSchema.parse(after);
  if (actor.origin !== origin || actor.coderUserId !== binding.actorCoderUserId)
    throw new TemplateLogAccessError("actor_revoked");
  const live = () => {
    if (
      actor.sessionExpiresAt.getTime() <= Date.now() ||
      (actor.tokenExpiresAt && actor.tokenExpiresAt.getTime() <= Date.now()) ||
      signal.aborted
    )
      throw new TemplateLogAccessError("actor_revoked");
  };
  const response = async (path: string) => {
    live();
    const result = await publicationFetch(
      transport(origin + path, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: { "Coder-Session-Token": actor.token, "Accept-Encoding": "identity" },
        signal,
      }),
      signal,
    );
    if (result.status !== 200 || result.redirected) {
      await cancelPublicationBody(result);
      throw new TemplateLogAccessError(
        [401, 403].includes(result.status)
          ? "actor_revoked"
          : result.status === 404
            ? "not_found"
            : "unavailable",
      );
    }
    return result;
  };
  const json = async (path: string) => {
    const res = await response(path);
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await publicationBody(res, 262144, signal)),
    ) as unknown;
  };
  const me = z.object({ id: uuid }).parse(await json("/api/v2/users/me"));
  if (me.id !== actor.coderUserId) throw new TemplateLogAccessError("actor_revoked");
  const verify = async () => {
    const v = versionSchema.parse(
      await json(`/api/v2/templateversions/${uuid.parse(binding.versionId)}`),
    );
    if (
      v.id !== binding.versionId ||
      v.organization_id !== binding.organizationId ||
      v.name !== binding.versionName ||
      v.message !== binding.message ||
      v.created_by.id !== binding.actorCoderUserId ||
      v.job.id !== binding.importJobId ||
      v.job.file_id !== binding.fileId ||
      v.job.organization_id !== binding.organizationId ||
      v.job.initiator_id !== binding.actorCoderUserId ||
      ((binding.operationMode !== "create" || binding.stage === "succeeded") &&
        (v.template_id ?? null) !== binding.templateId)
    )
      throw new TemplateLogAccessError("identity_changed");
    // An original unattached create import can later be attached during an
    // unknown create ACK. Its exact original file/version/job is readable, never
    // adopted as a target UUID or publication/execution permission here.
  };
  await verify();
  const bodySignal = AbortSignal.any([signal, AbortSignal.timeout(TEMPLATE_LOG_LIMITS.readMs)]);
  let logs: Response;
  try {
    logs = await publicationFetch(
      transport(
        `${origin}/api/v2/templateversions/${uuid.parse(binding.versionId)}/logs?after=${after}`,
        {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: { "Coder-Session-Token": actor.token, "Accept-Encoding": "identity" },
          signal: bodySignal,
        },
      ),
      bodySignal,
    );
  } catch {
    return {
      records: [],
      nextAfter: after,
      hasMore: true,
      fallback: bodySignal.aborted ? "deadline" : "provider_unavailable",
    };
  }
  if (logs.status !== 200 || logs.redirected) {
    await cancelPublicationBody(logs);
    if ([401, 403].includes(logs.status)) throw new TemplateLogAccessError("actor_revoked");
    return { records: [], nextAfter: after, hasMore: true, fallback: "provider_unavailable" };
  }
  const page = await readTemplateLogArray(logs, after, bodySignal);
  live();
  await verify();
  return page;
}
