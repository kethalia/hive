import { createPublicKey, verify } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import {
  type RegistrationBinding,
  type RegistrationPrincipal,
  WorkspaceRegistrationAuthority,
} from "./registration.server";
import {
  lockActiveRegistration,
  PrismaRegistrationStore,
  RegistrationRejected,
} from "./registration-store.server";
import { issueCodexSessionGrant } from "./ticket.server";

const heartbeatSchema = z
  .object({
    registrationId: z.string().uuid(),
    serverInstanceId: z.string().min(1).max(200),
    sequence: z.number().int().positive().max(2147483647),
    nonce: z.string().uuid(),
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type HeartbeatRequest = z.infer<typeof heartbeatSchema>;
export const heartbeatPayload = (v: Omit<HeartbeatRequest, "proof">) =>
  `hive-host-heartbeat-v1\n${JSON.stringify({ registrationId: v.registrationId, serverInstanceId: v.serverInstanceId, sequence: v.sequence, nonce: v.nonce })}`;
export type RegisteredSessionConfig = {
  privateKeyPem: string;
  keyId: string;
  hiveOrigin: string;
  softwareTemplateIds: string[];
  appSlug: string;
  gatewayPort: number;
  cookieDomains: string[];
};
const activeProjectIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(32)
  .refine((ids) => new Set(ids).size === ids.length);
/** Internal controller selection, or project IDs taken from a verified signed/
 * persisted binding. Never called with unsigned host registration parameters. */
export async function loadActiveRegistrationProjects(
  db: PrismaClient,
  principal: RegistrationPrincipal,
  requestedProjectIds: string[],
) {
  const projectIds = activeProjectIdsSchema.parse(requestedProjectIds);
  const rows = await db.deliveryProject.findMany({
    where: { ownerId: principal.hiveUserId, provider: "github", id: { in: projectIds } },
    orderBy: { id: "asc" },
  });
  if (rows.length !== projectIds.length) throw new RegistrationRejected();
  return rows.map((p) => ({ projectId: p.id, repositoryId: p.providerRepositoryId }));
}
/** Explicitly disabled unless deployment supplies all authority configuration. */
export function registeredSessionConfig(): RegisteredSessionConfig {
  if (process.env.HIVE_CODEX_GATEWAY_ENABLED !== "true") throw new RegistrationRejected();
  const required = (key: string) => {
    const v = process.env[key];
    if (!v) throw new RegistrationRejected();
    return v;
  };
  return {
    privateKeyPem: required("HIVE_CODEX_ISSUER_PRIVATE_KEY"),
    keyId: required("HIVE_CODEX_ISSUER_KEY_ID"),
    hiveOrigin: required("HIVE_CODEX_HIVE_ORIGIN"),
    softwareTemplateIds: required("HIVE_CODEX_SOFTWARE_TEMPLATE_IDS").split(","),
    appSlug: required("HIVE_CODEX_APP_SLUG"),
    gatewayPort: Number(required("HIVE_CODEX_GATEWAY_PORT")),
    cookieDomains: process.env.COOKIE_DOMAIN ? [process.env.COOKIE_DOMAIN] : [],
  };
}
export function createRegisteredSessionService(db: PrismaClient, config: RegisteredSessionConfig) {
  const store = new PrismaRegistrationStore(db);
  const authority = new WorkspaceRegistrationAuthority(config, {
    store,
    coderForPrincipal: async (principal) => {
      const user = await db.user.findUnique({ where: { id: principal.hiveUserId } });
      if (!user || user.coderUserId !== principal.coderUserId) throw new RegistrationRejected();
      return getCoderClientForUser(user.id);
    },
    // The internal controller selects active projects; historical projects do not count.
    authorizedProjects: (principal, _workspaceId, requestedProjectIds) =>
      loadActiveRegistrationProjects(db, principal, requestedProjectIds),
  });
  return new RegisteredSessionService(db, config, authority, store);
}
export class RegisteredSessionService {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: RegisteredSessionConfig,
    readonly authority: WorkspaceRegistrationAuthority,
    private readonly store: PrismaRegistrationStore,
  ) {}
  async redeem(value: unknown) {
    const r = await this.authority.redeem(value);
    const row = await this.db.codexHostRegistration.findFirstOrThrow({
      where: {
        ownerId: r.binding.hiveUserId,
        generation: r.generation,
        serverInstanceId: r.serverInstanceId,
        slot: {
          workspaceId: r.binding.workspaceId,
          agentId: r.binding.agentId,
          coderOrigin: r.binding.coderOrigin,
        },
      },
    });
    const active = await this.store.active(row.id);
    return {
      registrationId: row.id,
      expiresAt: Math.floor(active.registration.expiresAt.getTime() / 1000),
      sequence: active.registration.heartbeatSequence,
      nonce: active.registration.heartbeatNonce,
    };
  }
  async heartbeat(value: unknown) {
    const v = heartbeatSchema.parse(value),
      { registration: r } = await this.store.active(v.registrationId);
    const key = createPublicKey(r.hostPublicKeyPem);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(null, Buffer.from(heartbeatPayload(v)), key, Buffer.from(v.proof, "base64url"))
    )
      throw new RegistrationRejected();
    const binding = await this.authority.reauthorize(r.binding as unknown as RegistrationBinding);
    return this.store.renew({ ...v, ownerId: r.ownerId, binding });
  }
  async readGrant(principal: RegistrationPrincipal, projectId: string) {
    z.string().uuid().parse(projectId);
    const rows = await this.db.codexRegisteredThread.findMany({
      where: {
        ownerId: principal.hiveUserId,
        projectId,
        registration: { revokedAt: null, expiresAt: { gt: new Date() } },
      },
      include: { registration: true },
      take: 2,
    });
    if (rows.length !== 1) throw new RegistrationRejected();
    const row = rows[0],
      binding = row.registration.binding as unknown as RegistrationBinding;
    if (binding.ownerId !== principal.coderUserId) throw new RegistrationRejected();
    await this.authority.reauthorize(binding);
    return this.db.$transaction(async (tx) => {
      const {
        registration: r,
        slot,
        now,
      } = await lockActiveRegistration(tx, {
        ownerId: principal.hiveUserId,
        registrationId: row.registrationId,
      });
      const thread = r.threads.find(
        (t) =>
          t.projectId === projectId &&
          t.conversationId === row.conversationId &&
          t.nativeThreadId === row.nativeThreadId,
      );
      if (!thread || slot.coderOwnerId !== principal.coderUserId) throw new RegistrationRejected();
      const conversation = await tx.deliveryConversation.findUniqueOrThrow({
        where: { ownerId_id: { ownerId: principal.hiveUserId, id: thread.conversationId } },
      });
      if (
        conversation.buildId !== r.buildId ||
        conversation.serverInstanceId !== r.serverInstanceId ||
        conversation.nativeThreadId !== thread.nativeThreadId
      )
        throw new RegistrationRejected();
      // A read ticket may not outlive the authenticated host lease.
      const ttl = Math.min(
        60,
        Math.floor((r.expiresAt.getTime() - Math.max(now.getTime(), Date.now())) / 1000),
      );
      if (ttl < 1) throw new RegistrationRejected();
      return issueCodexSessionGrant(
        { ...this.config, appOrigin: r.appOrigin },
        {
          ownerId: slot.coderOwnerId,
          workspaceId: slot.workspaceId,
          buildId: r.buildId,
          serverInstanceId: r.serverInstanceId,
          threadId: thread.nativeThreadId,
        },
        ttl,
      );
    });
  }
}
