import { neon } from "@neondatabase/serverless";
import { createHandler } from "./worker-core.mjs";

// HTTP supports atomic noninteractive batches. Interactive Prisma transactions
// require their own adapter/transport spike and are not claimed by this probe.
export default {
  fetch: createHandler({
    createSql: (url) => neon(url, { fetchOptions: { signal: AbortSignal.timeout(15_000) } }),
  }),
};
