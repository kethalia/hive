import type { PrismaClient } from "@hive/db";
import { z } from "zod";
import { withReleaseDeadline } from "../../../deploy/cloudflare/app/release-health";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
type Controller = {
  step(ownerId: string, actionId: string, signal: AbortSignal): Promise<unknown>;
  observe(ownerId: string, releaseId: string, signal: AbortSignal): Promise<unknown>;
  builds: {
    verifyRun(ownerId: string, releaseId: string, signal: AbortSignal): Promise<unknown>;
  } | null;
};
type Row = { id: string; owner_id: string; purpose?: string };
/** Fixed-target pump for existing durable records. Every effect still goes
 * through controller fencing and independent authorization; this does not
 * create releases, select source, waive policy or turn uncertainty into retry.
 * Per-kind cursors prevent a held record from starving other work. */
export class ReleaseScheduler {
  private readonly targetDigest: string;
  private running = false;
  private actionCursor = "00000000-0000-0000-0000-000000000000";
  private verificationCursor = this.actionCursor;
  private observationCursor = this.actionCursor;
  private plannerCursor = this.actionCursor;
  constructor(
    private readonly db: PrismaClient,
    targetDigest: string,
    private readonly controller: Controller,
    private readonly planner?: {
      advance(ownerId: string, releaseId: string, signal?: AbortSignal): Promise<unknown>;
    },
    private readonly opener?: { tick(signal: AbortSignal): Promise<unknown> },
    private readonly databaseObserver?: {
      observe(ownerId: string, releaseId: string, signal: AbortSignal): Promise<unknown>;
    },
  ) {
    this.targetDigest = digest.parse(targetDigest);
  }
  async tick(parent: AbortSignal) {
    if (parent.aborted || this.running) return { status: "skipped" as const };
    this.running = true;
    const counts = { actions: 0, verifications: 0, observations: 0, held: 0 };
    try {
      const opener = this.opener;
      if (opener) {
        try {
          await withReleaseDeadline((signal) => opener.tick(signal), parent, 30000);
        } catch {
          counts.held++;
        }
      }
      if (parent.aborted) return { status: "aborted" as const, ...counts };
      const actions = await this.db.$queryRaw<
        Row[]
      >`SELECT a.id,r.owner_id,r.purpose FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.target_digest=${this.targetDigest} AND t.active_release_id=r.id AND r.phase IN ('active','held') AND a.phase IN ('prepared','effect_started','held') AND a.id>${this.actionCursor}::uuid ORDER BY a.id LIMIT 8`;
      if (!actions.length) this.actionCursor = "00000000-0000-0000-0000-000000000000";
      for (const row of actions) {
        if (parent.aborted) break;
        this.actionCursor = row.id;
        try {
          const databaseObserver = this.databaseObserver;
          if (databaseObserver) {
            const scopes = await this.db.$queryRaw<
              { id: string; present: boolean; phase: string }[]
            >`SELECT r.id,r.snapshot ? 'database' AS present,a.phase FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id WHERE a.id=${row.id}::uuid AND r.owner_id=${row.owner_id}::uuid`;
            if (scopes[0]?.present && scopes[0].phase === "prepared")
              await withReleaseDeadline(
                (signal) => databaseObserver.observe(row.owner_id, scopes[0].id, signal),
                parent,
                15000,
              );
          }
          await withReleaseDeadline(
            (signal) => this.controller.step(row.owner_id, row.id, signal),
            parent,
            row.purpose === "automatic_production" ? 40000 : 15000,
          );
          counts.actions++;
        } catch {
          counts.held++;
        }
      }
      if (parent.aborted) return { status: "aborted" as const, ...counts };
      if (this.planner) {
        const candidates = await this.db.$queryRaw<
          Row[]
        >`SELECT r.id,r.owner_id,r.purpose FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.target_digest=${this.targetDigest} AND t.active_release_id=r.id AND r.phase IN ('active','held') AND r.id>${this.plannerCursor}::uuid ORDER BY r.id LIMIT 8`;
        if (!candidates.length) this.plannerCursor = "00000000-0000-0000-0000-000000000000";
        for (const row of candidates) {
          if (parent.aborted) break;
          this.plannerCursor = row.id;
          try {
            const databaseObserver = this.databaseObserver;
            if (databaseObserver) {
              const database = await this.db.$queryRaw<
                { present: boolean }[]
              >`SELECT snapshot ? 'database' AS present FROM delivery_releases WHERE id=${row.id}::uuid AND owner_id=${row.owner_id}::uuid`;
              if (database[0]?.present)
                await withReleaseDeadline(
                  (signal) => databaseObserver.observe(row.owner_id, row.id, signal),
                  parent,
                  15000,
                );
            }
            const planner = this.planner;
            if (row.purpose === "automatic_production")
              await withReleaseDeadline(
                (signal) => planner.advance(row.owner_id, row.id, signal),
                parent,
                40000,
              );
            else await planner.advance(row.owner_id, row.id);
          } catch {
            counts.held++;
          }
        }
      }
      if (parent.aborted) return { status: "aborted" as const, ...counts };
      const verifier = this.controller.builds;
      const builds = verifier
        ? await this.db.$queryRaw<
            Row[]
          >`SELECT r.id,r.owner_id FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest JOIN delivery_release_build_attestations b ON b.release_id=r.id AND b.owner_id=r.owner_id LEFT JOIN delivery_release_build_verifications v ON v.attestation_id=b.id AND v.owner_id=b.owner_id WHERE r.target_digest=${this.targetDigest} AND r.phase='active' AND t.active_release_id=r.id AND v.id IS NULL AND r.id>${this.verificationCursor}::uuid ORDER BY r.id LIMIT 8`
        : [];
      if (!builds.length) this.verificationCursor = "00000000-0000-0000-0000-000000000000";
      for (const row of builds) {
        if (parent.aborted) break;
        this.verificationCursor = row.id;
        try {
          await withReleaseDeadline(
            (signal) => {
              if (!verifier) throw Error("release_build_verifier_unavailable");
              return verifier.verifyRun(row.owner_id, row.id, signal);
            },
            parent,
            15000,
          );
          counts.verifications++;
        } catch {
          counts.held++;
        }
      }
      if (parent.aborted) return { status: "aborted" as const, ...counts };
      const observations = await this.db.$queryRaw<
        Row[]
      >`SELECT r.id,r.owner_id FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.target_digest=${this.targetDigest} AND (r.phase IN ('active','held') OR (r.purpose='automatic_production' AND r.phase='healthy')) AND t.active_release_id=r.id AND r.id>${this.observationCursor}::uuid AND EXISTS (SELECT 1 FROM delivery_release_actions a WHERE a.release_id=r.id AND (a.kind IN ('promote','recover') OR (r.purpose='automatic_production' AND a.kind='merge')) AND a.phase='observed') ORDER BY r.id LIMIT 8`;
      if (!observations.length) this.observationCursor = "00000000-0000-0000-0000-000000000000";
      for (const row of observations) {
        if (parent.aborted) break;
        this.observationCursor = row.id;
        try {
          await withReleaseDeadline(
            (signal) => this.controller.observe(row.owner_id, row.id, signal),
            parent,
            25000,
          );
          counts.observations++;
        } catch {
          counts.held++;
        }
      }
      return { status: parent.aborted ? ("aborted" as const) : ("complete" as const), ...counts };
    } finally {
      this.running = false;
    }
  }
}
