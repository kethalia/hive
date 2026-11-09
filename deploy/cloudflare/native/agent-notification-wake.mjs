import { DurableObject } from "cloudflare:workers";
import {
  AGENT_WAKE_ATTEMPT_MS,
  AGENT_WAKE_DURATION_MS,
  AGENT_WAKE_REQUEST_LIMIT,
  agentWakeEnrollment,
  agentWakeIdentitySchema,
  agentWakeName,
  agentWakeReceiptSchema,
  sameAgentWake,
} from "../../../src/lib/push/agent-event-wake-contracts";
import { runExactAgentNotificationWake } from "../app/agent-notification-wake";

/** One bounded SQLite row per exact enrolled event. Internal RPC only. */
class AgentNotificationWake extends DurableObject {
  #attemptRunning = false;
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS wake (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL CHECK(length(state)<=65536))",
    );
  }
  #read() {
    const row = this.ctx.storage.sql.exec("SELECT state FROM wake WHERE id=1").toArray()[0];
    return row ? agentWakeReceiptSchema.parse(JSON.parse(row.state)) : null;
  }
  #write(state) {
    const raw = JSON.stringify(agentWakeReceiptSchema.parse(state));
    if (new TextEncoder().encode(raw).length > 65536) throw new Error("agent_wake_state_bound");
    this.ctx.storage.sql.exec(
      "INSERT INTO wake VALUES (1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      raw,
    );
  }
  #authorized(value) {
    const identity = agentWakeIdentitySchema.parse(value),
      enrolled = agentWakeEnrollment(this.env);
    if (
      !enrolled ||
      !sameAgentWake(enrolled, identity) ||
      this.ctx.id.toString() !==
        this.env.HIVE_AGENT_NOTIFICATION_WAKE.idFromName(agentWakeName(identity)).toString()
    )
      throw new Error("agent_wake_unavailable");
    return identity;
  }
  async #receipt(value, create) {
    const identity = this.#authorized(value);
    return this.ctx.storage.transaction(async () => {
      const now = Date.now();
      let state = this.#read();
      if (!state) {
        if (!create || this.env.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED !== "true")
          throw new Error("agent_wake_missing");
        state = {
          schemaVersion: 1,
          ...identity,
          createdAt: now,
          deadline: now + AGENT_WAKE_DURATION_MS,
          requests: 0,
          attempts: 0,
          phase: "active",
          nextWake: now + 1e3,
          inFlightUntil: 0,
        };
      }
      if (!sameAgentWake(state, identity)) throw new Error("agent_wake_identity_conflict");
      state.requests = Math.min(Number.MAX_SAFE_INTEGER, state.requests + 1);
      if (
        state.phase === "active" &&
        (this.env.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED !== "true" ||
          now >= state.deadline ||
          state.requests >= AGENT_WAKE_REQUEST_LIMIT)
      )
        state.phase = "held";
      this.#write(state);
      if (state.phase === "active")
        await this.ctx.storage.setAlarm(Math.min(state.deadline, state.nextWake));
      else await this.ctx.storage.deleteAlarm();
      return state;
    });
  }
  reserve(identity) {
    return this.#receipt(identity, true);
  }
  inspect(identity) {
    return this.#receipt(identity, false);
  }
  async alarm() {
    const current = this.#read();
    if (!current) return;
    if (current.phase !== "active") {
      // Retried/no-op platform deliveries remain measurable after work stops.
      await this.ctx.storage.transaction(async () => {
        const row = this.#read();
        row.requests = Math.min(Number.MAX_SAFE_INTEGER, row.requests + 1);
        this.#write(row);
        await this.ctx.storage.deleteAlarm();
      });
      return;
    }
    let enrolled = null;
    try {
      enrolled = agentWakeEnrollment(this.env);
    } catch {}
    const state = await this.ctx.storage.transaction(async () => {
      const row = this.#read();
      if (!row || row.phase !== "active") return null;
      const now = Date.now();
      row.requests = Math.min(Number.MAX_SAFE_INTEGER, row.requests + 1);
      if (
        this.env.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED !== "true" ||
        !enrolled ||
        !sameAgentWake(row, enrolled) ||
        now >= row.deadline ||
        row.requests >= AGENT_WAKE_REQUEST_LIMIT
      ) {
        row.phase = "held";
        this.#write(row);
        await this.ctx.storage.deleteAlarm();
        return null;
      }
      if (this.#attemptRunning || row.inFlightUntil > now || row.nextWake > now) {
        this.#write(row);
        await this.ctx.storage.setAlarm(
          Math.min(row.deadline, Math.max(now + 1000, row.nextWake, row.inFlightUntil)),
        );
        return null;
      }
      row.attempts++;
      row.inFlightUntil = Math.min(row.deadline, now + AGENT_WAKE_ATTEMPT_MS);
      row.nextWake = Math.min(row.deadline, row.inFlightUntil + 5000);
      this.#write(row);
      // Persist the watchdog before any PostgreSQL/provider attempt.
      await this.ctx.storage.setAlarm(row.nextWake);
      return row;
    });
    if (!state) return;
    let result;
    this.#attemptRunning = true;
    try {
      result = await runExactAgentNotificationWake(this.env, state);
    } catch {
      result = { phase: "retry", nextWake: Date.now() + 1e4 };
    }
    this.#attemptRunning = false;
    await this.ctx.storage.transaction(async () => {
      const latest = this.#read();
      if (!latest || latest.phase !== "active" || latest.attempts !== state.attempts) return;
      latest.inFlightUntil = 0;
      if (Date.now() >= latest.deadline) latest.phase = "held";
      else if (result.phase !== "retry") latest.phase = result.phase;
      else latest.nextWake = Math.min(latest.deadline, Math.max(Date.now() + 1e3, result.nextWake));
      this.#write(latest);
      if (latest.phase === "active") await this.ctx.storage.setAlarm(latest.nextWake);
      else await this.ctx.storage.deleteAlarm();
    });
  }
}

export { AgentNotificationWake };
