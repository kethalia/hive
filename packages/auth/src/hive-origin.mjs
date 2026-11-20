import { AsyncLocalStorage } from "node:async_hooks";

const key = Symbol.for("hive.public-origin");
globalThis[key] ??= new AsyncLocalStorage();
const requestOrigin = globalThis[key];

/** @returns {string | undefined} */
export function getHivePublicOrigin() {
  return requestOrigin.getStore() ?? process.env.HIVE_PUBLIC_ORIGIN;
}

/**
 * @template T
 * @param {string} origin
 * @param {() => T} work
 * @returns {T}
 */
export function withHivePublicOrigin(origin, work) {
  return requestOrigin.run(origin, work);
}
