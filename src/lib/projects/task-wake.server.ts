import { AsyncLocalStorage } from "node:async_hooks";
import {
  sameTaskWake,
  type TaskWakeEnvironment,
  type TaskWakeIdentity,
  taskWakeEnrollment,
  taskWakeIdentitySchema,
  taskWakeName,
  taskWakeReceiptSchema,
} from "./task-wake-contracts";

const key = Symbol.for("hive.project-task-wake.request-context.v1");
const globalStore = globalThis as typeof globalThis & {
  [key]?: AsyncLocalStorage<TaskWakeEnvironment>;
};
if (!globalStore[key]) globalStore[key] = new AsyncLocalStorage<TaskWakeEnvironment>();
const context = globalStore[key];
/** Shared ALS crosses the framework/custom-Worker bundle boundary, never a client. */
export function withTaskWakeEnvironment<T>(env: TaskWakeEnvironment, operation: () => T): T {
  return context.run(env, operation);
}
export function taskWakeEnabled() {
  const env = context.getStore();
  if (!env && process.env.HIVE_PROJECT_TASK_WAKE_ENABLED === "true")
    throw new Error("task_wake_context_unavailable");
  return env?.HIVE_PROJECT_TASK_WAKE_ENABLED === "true";
}
export async function readTaskWake(identity: TaskWakeIdentity, reserve = false) {
  const env = context.getStore();
  taskWakeEnabled();
  if (!env || env.HIVE_PROJECT_TASK_WAKE_ENABLED !== "true") return null;
  const parsed = taskWakeIdentitySchema.parse(identity),
    enrolled = taskWakeEnrollment(env);
  if (!enrolled || !sameTaskWake(enrolled, parsed) || !env.HIVE_PROJECT_TASK_WAKE)
    throw new Error("task_wake_unavailable");
  const stub = env.HIVE_PROJECT_TASK_WAKE.getByName(taskWakeName(parsed));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: unknown;
  try {
    raw = await Promise.race([
      reserve ? stub.reserve(parsed) : stub.inspect(parsed),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("task_wake_unavailable")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const receipt = taskWakeReceiptSchema.parse(raw);
  if (!sameTaskWake(receipt, parsed)) throw new Error("task_wake_identity_conflict");
  return receipt;
}
export function assertTaskWakeActive(receipt: Awaited<ReturnType<typeof readTaskWake>>) {
  if (receipt && (receipt.phase !== "active" || receipt.deadline <= Date.now()))
    throw new Error("task_wake_held");
}
