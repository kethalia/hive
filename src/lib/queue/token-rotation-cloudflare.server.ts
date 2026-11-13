import { createHash, randomUUID } from "node:crypto";
import { encrypt, TOKEN_LIFETIME_SECONDS, tryDecrypt } from "@hive/auth";
import type { Prisma, PrismaClient } from "@hive/db";
import { z } from "zod";
import { fetchCoderApi } from "@/lib/coder/fetch";
import {
  PUSH_NOTIFICATION_HOURS,
  PUSH_NOTIFICATION_TAG,
  TOKEN_ROTATION_THRESHOLD,
} from "@/lib/constants";
import { sendBoundedPush } from "@/lib/push/bounded-send";
import type { PushPayload } from "@/lib/push/types";
import { cancelTerminalBody, terminalBody, terminalFetch } from "@/lib/terminal/transport-io";

type Transaction = Prisma.TransactionClient;
const hour = 3600000;
const lifetime = TOKEN_LIFETIME_SECONDS * 1000;
const hex = z.string().regex(/^[a-f0-9]+$/);
const keyId = z.string().regex(/^[A-Za-z0-9]{10}$/);
const name = z.string().regex(/^hive-r-[a-f0-9-]{36}$/);
const managedSchema = z.object({ id: keyId, name, version: z.number().int().positive() }).strict();
const scopeSchema = z
  .object({
    ownerId: z.string().uuid(),
    coderUserId: z.string().uuid(),
    origin: z.string().url(),
    version: z.number().int().positive(),
    cipherDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const encryptedSchema = z
  .object({ ciphertext: hex, iv: hex.length(24), authTag: hex.length(32) })
  .strict();
const pendingSchema = z
  .object({
    id: z.string().uuid(),
    name,
    scope: scopeSchema,
    phase: z.enum(["prepared", "minting", "minted", "cleanup", "discarding"]),
    oldManaged: managedSchema.nullable(),
    discardId: keyId.nullable().default(null),
    candidate: z
      .object({ id: keyId, expiresAt: z.string().datetime(), encrypted: encryptedSchema })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((value) => value.name === `hive-r-${value.id}`, "rotation_name_mismatch")
  .refine(
    (value) => (value.phase === "minted") === (value.candidate !== null),
    "rotation_candidate_mismatch",
  )
  .refine(
    (value) => (value.phase === "discarding") === (value.discardId !== null),
    "rotation_discard_mismatch",
  )
  .refine(
    (value) => value.phase !== "cleanup" || value.oldManaged !== null,
    "rotation_cleanup_mismatch",
  );
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    managed: managedSchema.nullable(),
    pending: pendingSchema.nullable(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
type Pending = z.infer<typeof pendingSchema>;
type Row = {
  id: string;
  userId: string;
  version: number;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  createdAt: Date;
  expiresAt: Date | null;
  coderUserId: string;
  origin: string;
  rotationState: unknown;
  warningNextAt: Date | null;
  leaseUntil: Date;
  now: Date;
};
const rowProjection = `t.id,t.user_id AS "userId",t.version,t.ciphertext,t.iv,t.auth_tag AS "authTag",
  t.created_at AS "createdAt",t.expires_at AS "expiresAt",u.coder_user_id AS "coderUserId",u.coder_url AS origin,
  t.rotation_state AS "rotationState",t.warning_next_at AS "warningNextAt",t.rotation_lease_until AS "leaseUntil",clock_timestamp() AS now`;
function cipherDigest(row: Pick<Row, "ciphertext" | "iv" | "authTag">) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [row.ciphertext, row.iv, row.authTag].map((value) => Buffer.from(value).toString("hex")),
      ),
    )
    .digest("hex");
}
function state(row: Row): State {
  return row.rotationState === null
    ? { schemaVersion: 1, managed: null, pending: null }
    : stateSchema.parse(row.rotationState);
}
function scope(row: Row) {
  return {
    ownerId: row.userId,
    coderUserId: row.coderUserId,
    origin: row.origin,
    version: row.version,
    cipherDigest: cipherDigest(row),
  };
}
function sameOwner(row: Row, pending: Pending) {
  return (
    row.userId === pending.scope.ownerId &&
    row.coderUserId === pending.scope.coderUserId &&
    row.origin === pending.scope.origin
  );
}
function sameCredential(row: Row, pending: Pending) {
  return (
    sameOwner(row, pending) &&
    row.version === pending.scope.version &&
    cipherDigest(row) === pending.scope.cipherDigest
  );
}
function plaintext(row: Pick<Row, "ciphertext" | "iv" | "authTag">, encryptionKey: string) {
  const result = tryDecrypt(
    {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.authTag),
    },
    encryptionKey,
  );
  if (!result.ok) throw Error("credential_unavailable");
  return result.plaintext;
}
function effectiveExpiry(row: Row) {
  return row.expiresAt?.getTime() ?? row.createdAt.getTime() + lifetime;
}
function due(row: Row) {
  const expires = effectiveExpiry(row);
  return (
    row.now.getTime() < expires &&
    row.now.getTime() >= expires - lifetime * (1 - TOKEN_ROTATION_THRESHOLD)
  );
}
async function save(tx: Transaction, row: Row, value: State) {
  const encoded = JSON.stringify(stateSchema.parse(value));
  if (Buffer.byteLength(encoded) > 8192) throw Error("rotation_state_limit");
  await tx.$executeRaw`UPDATE coder_tokens SET rotation_state=${encoded}::jsonb WHERE id=${row.id}::uuid`;
}

type SendWarning = (
  tx: Transaction,
  ownerId: string,
  payload: PushPayload,
  signal: AbortSignal,
  deadline: number,
) => Promise<unknown>;
export type LegacyRotationOptions = {
  ownerId?: string;
  deadline?: number;
  signal?: AbortSignal;
  limit?: number;
  fetch?: typeof fetchCoderApi;
  sendWarning?: SendWarning;
};

/** Named-token API contract is pinned to Coder v2.38.4 codersdk/apikey.go.
 * Persisted names reconcile an uncertain mint. Provider GET never reveals its secret. */
export async function dispatchLegacyTokenRotation(
  db: PrismaClient,
  options: LegacyRotationOptions = {},
) {
  const deadline = options.deadline ?? Date.now() + 25000;
  const limit = options.limit ?? 3;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 5 ||
    !Number.isSafeInteger(deadline) ||
    deadline > Date.now() + 30000
  )
    throw Error("rotation_bounds_invalid");
  const ownerId = options.ownerId === undefined ? null : z.string().uuid().parse(options.ownerId);
  const origin = process.env.CODER_URL ?? "";
  if (new URL(origin).origin !== origin || !["https:", "http:"].includes(new URL(origin).protocol))
    throw Error("rotation_origin_invalid");
  const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) throw Error("rotation_key_unavailable");
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ...(options.signal ? [options.signal] : []),
  ]);
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw Error("rotation_deadline");
  };
  const counts = { checked: 0, rotated: 0, reconciled: 0, warned: 0, held: 0 };
  const request = async (token: string, path: string, init: RequestInit = {}) => {
    check();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    return terminalFetch(
      (options.fetch ?? fetchCoderApi)(`${origin}${path}`, {
        ...init,
        redirect: "manual",
        signal: requestSignal,
        headers: { "Content-Type": "application/json", "Coder-Session-Token": token },
      }),
      requestSignal,
    );
  };
  const json = async (response: Response) =>
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await terminalBody(response, 65536, signal)),
    );
  const verifyUser = async (row: Row, token: string) => {
    const response = await request(token, "/api/v2/users/me");
    if (response.status !== 200) {
      await cancelTerminalBody(response);
      throw Error("owner_unavailable");
    }
    if (z.object({ id: z.string().uuid() }).parse(await json(response)).id !== row.coderUserId)
      throw Error("owner_mismatch");
  };
  const metadata = async (row: Row, token: string, pending: Pending, id?: string) => {
    const base = `/api/v2/users/${row.coderUserId}/keys/`;
    const response = await request(token, id ? `${base}${id}` : `${base}tokens/${pending.name}`);
    if (response.status === 404) {
      await cancelTerminalBody(response);
      return null;
    }
    if (response.status !== 200) {
      await cancelTerminalBody(response);
      throw Error("key_readback_unavailable");
    }
    const data = z
      .object({
        id: keyId,
        user_id: z.string().uuid(),
        token_name: name,
        login_type: z.literal("token"),
        expires_at: z.string().datetime(),
      })
      .parse(await json(response));
    if (
      data.user_id !== row.coderUserId ||
      data.token_name !== (id ? pending.oldManaged?.name : pending.name) ||
      (id && data.id !== id)
    )
      throw Error("key_provenance_mismatch");
    return data;
  };
  const sendWarning: SendWarning =
    options.sendWarning ??
    ((tx, ownerId, payload, warningSignal, warningDeadline) =>
      sendBoundedPush(
        tx,
        ownerId,
        payload,
        process.env.VAPID_SUBJECT?.trim() || process.env.HIVE_PUBLIC_ORIGIN?.trim() || "",
        warningSignal,
        warningDeadline,
      ));

  for (let index = 0; index < limit && Date.now() < deadline && !signal.aborted; index++) {
    const leaseId = randomUUID();
    const [claimed] = await db.$queryRaw<Row[]>`
      WITH candidate AS (
        SELECT t.id FROM coder_tokens t JOIN users u ON u.id=t.user_id
        WHERE u.coder_url=${origin} AND (${ownerId}::uuid IS NULL OR u.id=${ownerId}::uuid) AND t.rotation_next_at<=clock_timestamp()
          AND (t.rotation_lease_until IS NULL OR t.rotation_lease_until<=clock_timestamp())
          AND ((COALESCE(t.expires_at,t.created_at+${lifetime}*interval '1 millisecond')>clock_timestamp()
            AND clock_timestamp()>=COALESCE(t.expires_at,t.created_at+${lifetime}*interval '1 millisecond')-${lifetime * (1 - TOKEN_ROTATION_THRESHOLD)}*interval '1 millisecond')
            OR t.rotation_state->'pending' IS DISTINCT FROM 'null'::jsonb AND t.rotation_state->'pending' IS NOT NULL)
        ORDER BY t.rotation_next_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1
      ) UPDATE coder_tokens t SET rotation_lease_id=${leaseId}::uuid,
        rotation_lease_until=clock_timestamp()+interval '60 seconds',rotation_next_at=clock_timestamp()+interval '1 hour'
      FROM candidate c,users u WHERE t.id=c.id AND u.id=t.user_id
      RETURNING t.id,t.user_id AS "userId",t.version,t.ciphertext,t.iv,t.auth_tag AS "authTag",
        t.created_at AS "createdAt",t.expires_at AS "expiresAt",u.coder_user_id AS "coderUserId",u.coder_url AS origin,
        t.rotation_state AS "rotationState",t.warning_next_at AS "warningNextAt",t.rotation_lease_until AS "leaseUntil",clock_timestamp() AS now`;
    if (!claimed) break;
    counts.checked++;
    const locked = <T>(work: (tx: Transaction, row: Row, value: State) => Promise<T>) =>
      db.$transaction(
        async (tx) => {
          check();
          // Lock both the credential and its principal before each remote effect.
          await tx.$queryRaw`SELECT t.id FROM coder_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=${claimed.id}::uuid FOR UPDATE OF t,u`;
          const [row] = await tx.$queryRawUnsafe<Row[]>(
            `SELECT ${rowProjection} FROM coder_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=$1::uuid AND t.rotation_lease_id=$2::uuid`,
            claimed.id,
            leaseId,
          );
          if (
            !row ||
            row.userId !== claimed.userId ||
            row.coderUserId !== claimed.coderUserId ||
            row.origin !== origin ||
            row.leaseUntil <= row.now
          )
            throw Error("rotation_claim_stale");
          const result = await work(tx, row, state(row));
          check();
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          if (clock.now >= row.leaseUntil) throw Error("rotation_claim_expired");
          return result;
        },
        { maxWait: 5000, timeout: Math.max(1, Math.min(15000, deadline - Date.now())) },
      );
    try {
      const warned = await locked(async (tx, row) => {
        if (row.version !== claimed.version || cipherDigest(row) !== cipherDigest(claimed)) return;
        const remaining = effectiveExpiry(row) - row.now.getTime();
        if (
          remaining <= 0 ||
          remaining > PUSH_NOTIFICATION_HOURS * hour ||
          (row.warningNextAt && row.warningNextAt > row.now)
        )
          return;
        await tx.$executeRaw`UPDATE coder_tokens SET warning_next_at=clock_timestamp()+interval '1 hour' WHERE id=${row.id}::uuid`;
        const warningDeadline = Math.min(deadline, Date.now() + 5000);
        const warningSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, warningDeadline - Date.now())),
        ]);
        // Best-effort hourly warning, retaining the original stable browser tag.
        try {
          const outcome = await sendWarning(
            tx,
            row.userId,
            {
              title: "Token expiring",
              body: `Your Coder API token expires in ${Math.round(remaining / hour)}h. Tap to re-authenticate.`,
              tag: PUSH_NOTIFICATION_TAG,
              kind: "token",
              url: "/login",
            },
            warningSignal,
            warningDeadline,
          );
          return outcome === "delivered";
        } catch {
          /* The hourly claim still bounds failures and unknown delivery. */
        }
      });
      if (warned) counts.warned++;
      let created = false;
      await locked(async (tx, row, value) => {
        if (value.pending || !due(row)) return;
        const current = plaintext(row, encryptionKey);
        const oldManaged =
          value.managed?.version === row.version && current.startsWith(`${value.managed.id}-`)
            ? value.managed
            : null;
        const id = randomUUID();
        value.pending = {
          id,
          name: `hive-r-${id}`,
          scope: scope(row),
          phase: "prepared",
          oldManaged,
          discardId: null,
          candidate: null,
        };
        await save(tx, row, value);
      });
      const phase = await locked(async (_tx, _row, value) => value.pending?.phase);
      if (!phase) continue;
      if (phase === "prepared") {
        created = await locked(async (tx, row, value) => {
          const pending = value.pending;
          if (!pending) throw Error("rotation_state_changed");
          if (!sameCredential(row, pending)) {
            if (!sameOwner(row, pending)) throw Error("rotation_owner_changed");
            value.pending = null;
            await save(tx, row, value);
            return false;
          }
          const current = plaintext(row, encryptionKey);
          await verifyUser(row, current);
          if (await metadata(row, current, pending)) throw Error("rotation_name_conflict");
          pending.phase = "minting";
          await save(tx, row, value);
          return true;
        });
      }
      if (created) {
        await locked(async (tx, row, value) => {
          const pending = value.pending;
          if (!pending) throw Error("rotation_state_changed");
          if (pending.phase !== "minting" || !sameCredential(row, pending))
            throw Error("rotation_credential_changed");
          const current = plaintext(row, encryptionKey);
          await verifyUser(row, current);
          const response = await request(current, `/api/v2/users/${row.coderUserId}/keys/tokens`, {
            method: "POST",
            body: JSON.stringify({
              token_name: pending.name,
              lifetime: TOKEN_LIFETIME_SECONDS * 1000000000,
            }),
          });
          if (response.status !== 201) {
            await cancelTerminalBody(response);
            throw Error("mint_outcome_unknown");
          }
          const key = z
            .object({ key: z.string().regex(/^[A-Za-z0-9]{10}-[A-Za-z0-9]{22}$/) })
            .parse(await json(response)).key;
          const registered = await metadata(row, current, pending);
          if (
            !registered ||
            registered.id !== key.slice(0, 10) ||
            Date.parse(registered.expires_at) <= Date.now()
          )
            throw Error("mint_outcome_unknown");
          await verifyUser(row, key);
          const encrypted = encrypt(key, encryptionKey);
          pending.candidate = {
            id: registered.id,
            expiresAt: registered.expires_at,
            encrypted: {
              ciphertext: Buffer.from(encrypted.ciphertext).toString("hex"),
              iv: Buffer.from(encrypted.iv).toString("hex"),
              authTag: Buffer.from(encrypted.authTag).toString("hex"),
            },
          };
          pending.phase = "minted";
          await save(tx, row, value);
        });
      } else if (phase === "minting") {
        await locked(async (tx, row, value) => {
          const pending = value.pending;
          if (!pending) throw Error("rotation_state_changed");
          if (!sameOwner(row, pending)) throw Error("rotation_owner_changed");
          const current = plaintext(row, encryptionKey);
          await verifyUser(row, current);
          const orphan = await metadata(row, current, pending);
          if (!orphan || current.startsWith(`${orphan.id}-`)) throw Error("mint_outcome_unknown");
          pending.phase = "discarding";
          pending.discardId = orphan.id;
          pending.candidate = null;
          await save(tx, row, value);
        });
      }
      const outcome = await locked(async (tx, row, value) => {
        const pending = value.pending;
        if (!pending || pending.phase !== "minted" || !pending.candidate) return;
        if (!sameOwner(row, pending)) throw Error("rotation_owner_changed");
        const current = plaintext(row, encryptionKey);
        await verifyUser(row, current);
        if (!sameCredential(row, pending)) {
          const orphan = await metadata(row, current, pending);
          if (orphan && (orphan.id !== pending.candidate.id || current.startsWith(`${orphan.id}-`)))
            throw Error("cleanup_provenance_mismatch");
          if (!orphan) {
            value.pending = null;
            await save(tx, row, value);
            return "reconciled" as const;
          }
          pending.phase = "discarding";
          pending.discardId = orphan.id;
          pending.candidate = null;
          await save(tx, row, value);
          return;
        }
        const candidate = pending.candidate;
        const encrypted = {
          ciphertext: Buffer.from(candidate.encrypted.ciphertext, "hex"),
          iv: Buffer.from(candidate.encrypted.iv, "hex"),
          authTag: Buffer.from(candidate.encrypted.authTag, "hex"),
        };
        const key = plaintext(encrypted, encryptionKey);
        await verifyUser(row, key);
        if (Date.parse(candidate.expiresAt) <= Date.now() || !key.startsWith(`${candidate.id}-`))
          throw Error("candidate_expired");
        const next = { ...row, ...encrypted, version: row.version + 1 };
        value.managed = { id: candidate.id, name: pending.name, version: next.version };
        value.pending = pending.oldManaged
          ? { ...pending, phase: "cleanup", scope: scope(next), candidate: null }
          : null;
        const changed =
          await tx.$executeRaw`UPDATE coder_tokens SET ciphertext=${encrypted.ciphertext},iv=${encrypted.iv},auth_tag=${encrypted.authTag},
          expires_at=${new Date(candidate.expiresAt)},version=version+1,updated_at=clock_timestamp(),rotation_state=${JSON.stringify(value)}::jsonb
          WHERE id=${row.id}::uuid AND version=${row.version}`;
        if (changed !== 1) throw Error("rotation_cas_conflict");
        return "rotated" as const;
      });
      if (outcome) counts[outcome]++;
      const discarded = await locked(async (tx, row, value) => {
        const pending = value.pending;
        if (!pending || pending.phase !== "discarding" || !pending.discardId) return false;
        if (!sameOwner(row, pending)) throw Error("cleanup_owner_changed");
        const current = plaintext(row, encryptionKey);
        if (current.startsWith(`${pending.discardId}-`)) throw Error("cleanup_active_key");
        await verifyUser(row, current);
        const orphan = await metadata(row, current, pending);
        if (orphan) {
          if (orphan.id !== pending.discardId) throw Error("cleanup_provenance_mismatch");
          const response = await request(
            current,
            `/api/v2/users/${row.coderUserId}/keys/${orphan.id}`,
            { method: "DELETE" },
          );
          await cancelTerminalBody(response);
          if (![204, 404].includes(response.status)) throw Error("cleanup_outcome_unknown");
        }
        value.pending = null;
        await save(tx, row, value);
        return true;
      });
      if (discarded) counts.reconciled++;
      await locked(async (tx, row, value) => {
        const pending = value.pending;
        if (!pending || pending.phase !== "cleanup" || !pending.oldManaged) return;
        if (!sameOwner(row, pending)) throw Error("cleanup_owner_changed");
        const current = plaintext(row, encryptionKey);
        if (current.startsWith(`${pending.oldManaged.id}-`)) throw Error("cleanup_active_key");
        await verifyUser(row, current);
        const old = await metadata(row, current, pending, pending.oldManaged.id);
        if (old) {
          const response = await request(
            current,
            `/api/v2/users/${row.coderUserId}/keys/${old.id}`,
            { method: "DELETE" },
          );
          await cancelTerminalBody(response);
          if (![204, 404].includes(response.status)) throw Error("cleanup_outcome_unknown");
        }
        value.pending = null;
        await save(tx, row, value);
      });
    } catch {
      counts.held++;
    } finally {
      // This exact claim cannot release a replacement claimant's lease.
      if (Date.now() < deadline && !signal.aborted)
        await db.$executeRaw`UPDATE coder_tokens SET rotation_lease_id=NULL,rotation_lease_until=NULL WHERE id=${claimed.id}::uuid AND rotation_lease_id=${leaseId}::uuid`;
    }
  }
  return counts;
}
