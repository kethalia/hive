import app from "../app/worker";
import auth from "../auth/worker";
import { type BackgroundEnvironment, repairBackground } from "./background";
import { createNativeWorker } from "./composition.mjs";

export { HiveBackground } from "./background-wake.mjs";

export default {
  ...createNativeWorker({ app, auth }),
  scheduled(
    _event: unknown,
    env: BackgroundEnvironment,
    context: { waitUntil(work: Promise<unknown>): void },
  ) {
    context.waitUntil(repairBackground(env));
  },
};
