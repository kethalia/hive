import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AgentWakeEnvironment,
  type AgentWakeIdentity,
  type AgentWakeReceipt,
  agentWakeEnrollment,
  agentWakeName,
  agentWakeReceiptSchema,
  sameAgentWake,
} from "./agent-event-wake-contracts";

const key = Symbol.for("hive.agent-notification-wake.request-context.v1");
const globalStore = globalThis as typeof globalThis & {
  [key]?: AsyncLocalStorage<AgentWakeEnvironment>;
};
if (!globalStore[key]) globalStore[key] = new AsyncLocalStorage<AgentWakeEnvironment>();
const context = globalStore[key];
export function withAgentWakeEnvironment<T>(env: AgentWakeEnvironment, operation: () => T): T {
  return context.run(env, operation);
}
export function agentWakeScope() {
  const env = context.getStore();
  if (
    !env &&
    (process.env.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED === "true" ||
      process.env.HIVE_AGENT_NOTIFICATION_WAKE_EVENT_JSON !== undefined)
  )
    throw Error("agent_wake_context_unavailable");
  return env ? agentWakeEnrollment(env) : null;
}
export async function readAgentWake(
  identity: AgentWakeIdentity,
  reserve = false,
): Promise<AgentWakeReceipt | null> {
  const enrolled = agentWakeScope();
  if (!enrolled || !sameAgentWake(identity, enrolled)) return null;
  const env = context.getStore();
  if (!env?.HIVE_AGENT_NOTIFICATION_WAKE) throw Error("agent_wake_unavailable");
  const stub = env.HIVE_AGENT_NOTIFICATION_WAKE.getByName(agentWakeName(identity));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const receipt = agentWakeReceiptSchema.parse(
      await Promise.race([
        reserve && env.HIVE_AGENT_NOTIFICATION_WAKE_ENABLED === "true"
          ? stub.reserve(identity)
          : stub.inspect(identity),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error("agent_wake_unavailable")), 5000);
        }),
      ]),
    );
    if (!sameAgentWake(receipt, identity)) throw Error("agent_wake_identity_conflict");
    return receipt;
  } finally {
    clearTimeout(timer);
  }
}
export function agentWakeActive(receipt: AgentWakeReceipt, now = Date.now()) {
  return receipt.phase === "active" && receipt.deadline > now;
}
