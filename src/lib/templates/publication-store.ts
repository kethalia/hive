import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import {
  type TemplateArtifactIdentity,
  TemplatePublicationError,
  type TemplateRemoteTarget,
} from "./publication-contracts";

const uuid = z.string().uuid();
export const jobStateSchema = z
  .object({
    target: z
      .object({
        organizationId: uuid,
        organizationName: z.string(),
        templateId: uuid.nullable(),
        name: z.string(),
        activeVersionId: uuid.nullable(),
        createdById: uuid.optional(),
      })
      .strict(),
    versionName: z.string(),
    message: z.string(),
    tagDigest: z.string().nullable(),
    fileId: uuid.nullable(),
    versionId: uuid.nullable(),
    importJobId: uuid.nullable(),
    effectIssued: z.boolean(),
  })
  .strict();
export type JobState = z.infer<typeof jobStateSchema>;
export type TemplateJob = {
  id: string;
  ownerId: string;
  requestId: string;
  coderUserId: string;
  sessionId: string;
  origin: string;
  organizationId: string;
  name: string;
  artifact: TemplateArtifactIdentity;
  state: JobState;
  phase: string;
  reason: string | null;
  holder: string | null;
  leaseUntil: Date | null;
  deadline: Date;
  attempts: number;
};
const columns = `id,owner_id AS "ownerId",request_id AS "requestId",coder_user_id AS "coderUserId",session_id AS "sessionId",origin,organization_id AS "organizationId",name,artifact,state,phase,reason,holder,lease_until AS "leaseUntil",deadline,attempts`;
const terminal = new Set(["succeeded", "failed", "held"]);
export const templateJobTerminal = (phase: string) => terminal.has(phase);
const fail = () => {
  throw new TemplatePublicationError("lease_lost");
};
function sameArtifact(left: TemplateArtifactIdentity, right: TemplateArtifactIdentity) {
  return (
    left.name === right.name &&
    left.archiveDigest === right.archiveDigest &&
    left.contentHash === right.contentHash &&
    left.archiveBytes === right.archiveBytes &&
    left.manifestDigest === right.manifestDigest
  );
}
export class TemplateJobStore {
  constructor(readonly db: PrismaClient) {}
  async enqueue(
    actor: { ownerId: string; coderUserId: string; sessionId: string; origin: string },
    artifact: TemplateArtifactIdentity,
    target: TemplateRemoteTarget,
    tagDigest: string | null,
    requestId: string,
  ) {
    uuid.parse(requestId);
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.origin}/${target.organizationId}/${target.name}`},0))`;
        const rows = await tx.$queryRawUnsafe<TemplateJob[]>(
          `SELECT ${columns} FROM template_jobs WHERE owner_id=$1::uuid AND request_id=$2::uuid`,
          actor.ownerId,
          requestId,
        );
        if (rows[0]) {
          if (
            rows[0].name !== artifact.name ||
            !sameArtifact(rows[0].artifact, artifact) ||
            rows[0].coderUserId !== actor.coderUserId ||
            rows[0].origin !== actor.origin
          )
            throw new TemplatePublicationError("request_conflict");
          return rows[0];
        }
        const active = await tx.$queryRawUnsafe<TemplateJob[]>(
          `SELECT ${columns} FROM template_jobs WHERE origin=$1 AND organization_id=$2::uuid AND name=$3 AND phase NOT IN ('succeeded','failed')`,
          actor.origin,
          target.organizationId,
          target.name,
        );
        if (active[0]) {
          // The unchanged UI has no client-generated request ID. An unknown enqueue
          // ACK can safely reconnect to this same owner's already queued artifact.
          if (
            active[0].ownerId === actor.ownerId &&
            sameArtifact(active[0].artifact, artifact) &&
            active[0].coderUserId === actor.coderUserId &&
            active[0].phase !== "held"
          )
            return active[0];
          throw new TemplatePublicationError("publication_busy");
        }
        const id = randomUUID();
        const state = jobStateSchema.parse({
          target,
          tagDigest,
          versionName: `hive-${id}`,
          message: `Hive publication ${id} ${artifact.archiveDigest}`,
          fileId: null,
          versionId: null,
          importJobId: null,
          effectIssued: false,
        });
        const [job] = await tx.$queryRawUnsafe<TemplateJob[]>(
          `INSERT INTO template_jobs(id,owner_id,request_id,coder_user_id,session_id,origin,organization_id,name,artifact,state,deadline)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9::jsonb,$10::jsonb,CURRENT_TIMESTAMP+interval '15 minutes') RETURNING ${columns}`,
          id,
          actor.ownerId,
          requestId,
          actor.coderUserId,
          actor.sessionId,
          actor.origin,
          target.organizationId,
          target.name,
          JSON.stringify(artifact),
          JSON.stringify(state),
        );
        return job;
      },
      { timeout: 10000, maxWait: 10000 },
    );
  }
  async read(ownerId: string, name: string, id: string) {
    uuid.parse(id);
    const [job] = await this.db.$queryRawUnsafe<TemplateJob[]>(
      `SELECT ${columns} FROM template_jobs WHERE id=$1::uuid AND owner_id=$2::uuid AND name=$3`,
      id,
      ownerId,
      name,
    );
    return job ?? null;
  }
  async claim(ownerId?: string) {
    const owner = ownerId === undefined ? null : uuid.parse(ownerId);
    const [job] = await this.db.$queryRawUnsafe<TemplateJob[]>(
      `WITH next AS (
      SELECT id FROM template_jobs WHERE phase NOT IN ('succeeded','failed','held') AND next_attempt_at<=clock_timestamp()
        AND ($2::uuid IS NULL OR owner_id=$2::uuid)
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE template_jobs j SET holder=$1::uuid,lease_until=clock_timestamp()+interval '90 seconds',attempts=least(attempts+1,128)
    FROM next WHERE j.id=next.id RETURNING ${columns
      .split(",")
      .map((field) => `j.${field}`)
      .join(",")}`,
      randomUUID(),
      owner,
    );
    if (job) job.state = jobStateSchema.parse(job.state);
    return job ?? null;
  }
  /** Persist effect admission before issuing any provider mutation. */
  async markEffect(job: TemplateJob, phase: string) {
    const state = jobStateSchema.parse({ ...job.state, effectIssued: true });
    const count = await this.db
      .$executeRaw`UPDATE template_jobs SET state=${JSON.stringify(state)}::jsonb,phase=${phase}
      WHERE id=${job.id}::uuid AND holder=${job.holder}::uuid AND lease_until>clock_timestamp() AND deadline>clock_timestamp() AND phase=${job.phase}`;
    if (count !== 1) fail();
    job.state = state;
    job.phase = phase;
  }
  async save(
    job: TemplateJob,
    phase: string,
    state: JobState,
    reason: string | null = null,
    delayMs = 0,
  ) {
    jobStateSchema.parse(state);
    await this.db.$transaction(
      async (tx) => {
        const count =
          await tx.$executeRaw`UPDATE template_jobs SET phase=${phase},state=${JSON.stringify(state)}::jsonb,reason=${reason},holder=NULL,lease_until=NULL,
        next_attempt_at=clock_timestamp()+${delayMs}*interval '1 millisecond'
        WHERE id=${job.id}::uuid AND holder=${job.holder}::uuid AND lease_until>clock_timestamp() AND phase=${job.phase}`;
        if (count !== 1) fail();
        if (terminal.has(phase))
          await tx.$executeRaw`INSERT INTO template_notices(id,owner_id,job_id) VALUES(${randomUUID()}::uuid,${job.ownerId}::uuid,${job.id}::uuid) ON CONFLICT(job_id) DO NOTHING`;
      },
      { timeout: 10000, maxWait: 10000 },
    );
  }
}
