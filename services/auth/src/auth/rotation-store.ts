import { randomUUID } from "node:crypto";
import { encrypt, isConfiguredCoderUrl } from "@hive/auth";
import type { Prisma, PrismaClient } from "@hive/db";
import { CredentialCASConflict } from "./credential-store";
import type { ManagedCoderKey } from "./managed-keys";
import {
  ROTATION_LIMITS,
  type RotationClaim,
  RotationLeaseLost,
  type RotationOperation,
  type RotationToken,
} from "./rotation-contracts";

type Transaction = Prisma.TransactionClient;

/** No credential bytes enter the scheduler, operation or notification records. */
export class CredentialRotationStore {
  constructor(private readonly db: PrismaClient) {}

  async claim(configuredOrigin: string): Promise<RotationClaim | null> {
    const holder = randomUUID();
    await this.db.$executeRaw`
      INSERT INTO credential_rotation_schedules(id, configured_origin)
      VALUES(${randomUUID()}::uuid, ${configuredOrigin}) ON CONFLICT(configured_origin) DO NOTHING`;
    const rows = await this.db.$queryRaw<RotationClaim[]>`
      UPDATE credential_rotation_schedules SET holder=${holder}::uuid,
        generation=generation+1, lease_until=clock_timestamp()+${ROTATION_LIMITS.leaseMs}*interval '1 millisecond',
        sweep_started_at=COALESCE(sweep_started_at,clock_timestamp()),updated_at=clock_timestamp()
      WHERE configured_origin=${configuredOrigin} AND next_run_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      RETURNING id,configured_origin AS "configuredOrigin",holder,generation,after_id AS "afterId"`;
    return rows[0] ?? null;
  }

  private async lock(tx: Transaction, claim: RotationClaim) {
    if (!isConfiguredCoderUrl(claim.configuredOrigin)) throw new RotationLeaseLost();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM credential_rotation_schedules WHERE id=${claim.id}::uuid
        AND configured_origin=${claim.configuredOrigin} AND holder=${claim.holder}::uuid
        AND generation=${claim.generation} AND lease_until>clock_timestamp() FOR UPDATE`;
    if (!rows.length) throw new RotationLeaseLost();
  }

  async next(claim: RotationClaim): Promise<RotationToken | null> {
    const rows = await this.db.coderToken.findMany({
      where: claim.afterId ? { id: { gt: claim.afterId } } : {},
      include: { user: true },
      orderBy: { id: "asc" },
      take: 1,
    });
    return rows[0] ?? null;
  }

  private async current(tx: Transaction, token: RotationToken) {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${token.userId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM coder_tokens WHERE id=${token.id}::uuid FOR UPDATE`;
    const current = await tx.coderToken.findUnique({
      where: { id: token.id },
      include: { user: true },
    });
    if (
      !current ||
      current.userId !== token.userId ||
      current.version !== token.version ||
      current.user.coderUserId !== token.user.coderUserId ||
      !isConfiguredCoderUrl(current.user.coderUrl)
    )
      throw new CredentialCASConflict();
    return current;
  }

  async prepare(
    claim: RotationClaim,
    token: RotationToken,
    input: { mint: boolean; notify: boolean; expiresAt: number },
  ): Promise<RotationOperation | null> {
    return this.db.$transaction(async (tx) => {
      await this.lock(tx, claim);
      await this.current(tx, token);
      if (input.notify)
        await tx.$executeRaw`
          INSERT INTO credential_expiry_notices(id,owner_id,token_id,token_version,configured_origin,expires_at)
          VALUES(${randomUUID()}::uuid,${token.userId}::uuid,${token.id}::uuid,${token.version},
            ${claim.configuredOrigin},${new Date(input.expiresAt)})
          ON CONFLICT(token_id,token_version) DO NOTHING`;
      if (!input.mint) return null;
      const operation: RotationOperation = {
        id: randomUUID(),
        ownerId: token.userId,
        tokenId: token.id,
        tokenVersion: token.version,
        coderUserId: token.user.coderUserId,
        configuredOrigin: claim.configuredOrigin,
        holder: claim.holder,
        generation: claim.generation,
      };
      const count = await tx.$executeRaw`
        INSERT INTO credential_rotation_operations(id,owner_id,token_id,token_version,coder_user_id,
          configured_origin,holder,schedule_generation,phase)
        VALUES(${operation.id}::uuid,${operation.ownerId}::uuid,${token.id}::uuid,${token.version},
          ${operation.coderUserId}::uuid,${claim.configuredOrigin},${claim.holder}::uuid,${claim.generation},'minting')
        ON CONFLICT(token_id,token_version) DO NOTHING`;
      return count === 1 ? operation : null;
    });
  }

  async commit(
    claim: RotationClaim,
    operation: RotationOperation,
    token: RotationToken,
    candidate: ManagedCoderKey,
    encryptionKey: string,
  ) {
    const encrypted = encrypt(candidate.token, encryptionKey);
    await this.db.$transaction(async (tx) => {
      await this.lock(tx, claim);
      await this.current(tx, token);
      await this.lock(tx, claim);
      const count = await tx.coderToken.updateMany({
        where: { id: token.id, userId: token.userId, version: token.version },
        data: {
          ciphertext: new Uint8Array(encrypted.ciphertext),
          iv: new Uint8Array(encrypted.iv),
          authTag: new Uint8Array(encrypted.authTag),
          expiresAt: candidate.expiresAt,
          remoteKeyId: candidate.id,
          version: { increment: 1 },
        },
      });
      if (count.count !== 1) throw new CredentialCASConflict();
      const updated = await tx.$executeRaw`
        UPDATE credential_rotation_operations SET phase='stored',remote_key_id=${candidate.id},
          reason='stored',finished_at=clock_timestamp()
        WHERE id=${operation.id}::uuid AND owner_id=${token.userId}::uuid AND token_id=${token.id}::uuid
          AND token_version=${token.version} AND holder=${claim.holder}::uuid
          AND schedule_generation=${claim.generation} AND phase='minting'`;
      if (updated !== 1) throw new CredentialCASConflict();
    });
  }

  async finish(
    operation: RotationOperation,
    phase: "uncertain" | "not_stored",
    reason: "mint_unknown" | "write_unknown" | "rolled_back" | "cleanup_failed",
    remoteKeyId: string | null = null,
  ) {
    // This records an old worker's own factual outcome, never a new lease or a
    // remint permission. Even not_stored remains consumed for this generation.
    await this.db.$executeRaw`
      UPDATE credential_rotation_operations SET phase=${phase},reason=${reason},
        remote_key_id=${remoteKeyId},finished_at=clock_timestamp()
      WHERE id=${operation.id}::uuid AND owner_id=${operation.ownerId}::uuid
        AND token_id=${operation.tokenId}::uuid AND token_version=${operation.tokenVersion}
        AND holder=${operation.holder}::uuid AND schedule_generation=${operation.generation} AND phase='minting'`;
  }

  async advance(claim: RotationClaim, afterId: string | null, finished = false) {
    await this.db.$transaction(async (tx) => {
      await this.lock(tx, claim);
      await tx.$executeRaw`
        UPDATE credential_rotation_schedules SET after_id=${afterId}::uuid,updated_at=clock_timestamp(),
          holder=CASE WHEN ${finished} THEN NULL ELSE holder END,
          lease_until=CASE WHEN ${finished} THEN NULL ELSE lease_until END,
          next_run_at=CASE WHEN ${finished} THEN clock_timestamp()+${ROTATION_LIMITS.sweepMs}*interval '1 millisecond' ELSE next_run_at END,
          sweep_started_at=CASE WHEN ${finished} THEN NULL ELSE sweep_started_at END
        WHERE id=${claim.id}::uuid`;
    });
    claim.afterId = afterId;
  }

  async release(claim: RotationClaim) {
    await this.db.$executeRaw`
      UPDATE credential_rotation_schedules SET holder=NULL,lease_until=NULL,next_run_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=${claim.id}::uuid AND holder=${claim.holder}::uuid AND generation=${claim.generation}
        AND lease_until>clock_timestamp()`;
  }
}
