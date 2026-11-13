import { DurableObject } from "cloudflare:workers";
import { dispatchBackground } from "./background";

/** A per-user alarm carries wake times. Jobs and claims remain in Postgres. */
export class HiveBackground extends DurableObject {
  async wake(ownerId, notBefore = Date.now()) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ownerId) ||
      !Number.isSafeInteger(notBefore) ||
      notBefore > Date.now() + 86400000
    )
      throw new Error("Invalid background wake");
    await this.ctx.storage.transaction(async (storage) => {
      const owner = await storage.get("owner");
      if (owner && owner !== ownerId) throw new Error("Background owner mismatch");
      await storage.put("owner", ownerId);
      const pending = await storage.get("pending");
      const at = Math.max(Date.now() + 100, Math.min(pending ?? Infinity, notBefore));
      await storage.put("pending", at);
      const alarm = await storage.getAlarm();
      if (alarm === null || at < alarm) await storage.setAlarm(at);
    });
  }

  async alarm() {
    // Consume the wake before network work. A concurrent wake writes a new
    // pending time, which the final transaction always preserves.
    const owner = await this.ctx.storage.transaction(async (storage) => {
      const owner = await storage.get("owner");
      if (!owner) throw new Error("Background owner unavailable");
      await storage.delete("pending");
      await storage.setAlarm(Date.now() + 120000);
      return owner;
    });
    // A failed invocation retains its persisted fallback alarm.
    const next = await dispatchBackground(this.env, owner);
    await this.ctx.storage.transaction(async (storage) => {
      const pending = await storage.get("pending");
      const due = Math.min(pending ?? Infinity, next ?? Infinity);
      if (Number.isFinite(due)) {
        const at = Math.max(Date.now() + 1000, due);
        await storage.put("pending", at);
        await storage.setAlarm(at);
      } else {
        await storage.delete("pending");
        await storage.deleteAlarm();
      }
    });
  }
}
