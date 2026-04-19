/**
 * Next.js instrumentation hook — runs once when the server starts.
 * Used to bootstrap BullMQ workers so jobs are processed without a
 * separate worker process.
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Only run in the Node.js runtime (not Edge), and only on the server
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { createTemplatePushWorker } = await import("@/lib/templates/push-queue");
  const { createTokenRotationWorker, scheduleTokenRotation } = await import("@/lib/queue/token-rotation");

  createTemplatePushWorker();
  console.log("[instrumentation] Template push worker started");

  createTokenRotationWorker();
  await scheduleTokenRotation();
  console.log("[instrumentation] Token rotation worker started");
}
