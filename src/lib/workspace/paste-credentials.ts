import { getCoderClientForUser } from "@/lib/coder/user-client";
import { TERMINAL_PASTE_MAX_ACTIVE_REQUESTS } from "./paste-admission";
import { PasteRequestError } from "./paste-request";

// Prisma queries cannot be aborted. Keep a separate, bounded set until they
// actually finish so repeated timed-out requests cannot accumulate DB work.
const pendingUsers = new Set<string>();

export async function getTerminalPasteCoderClient(userId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (pendingUsers.has(userId) || pendingUsers.size >= TERMINAL_PASTE_MAX_ACTIVE_REQUESTS) {
    throw new PasteRequestError("Paste credential lookups are busy. Try again shortly.", 429);
  }
  pendingUsers.add(userId);
  const lookup = getCoderClientForUser(userId).finally(() => pendingUsers.delete(userId));
  if (!signal) return lookup;
  return new Promise<Awaited<typeof lookup>>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    // Both outcomes are observed even after abort, so late failures are harmless
    // and late credentials never restart the upload continuation.
    lookup.then(
      (client) => {
        signal.removeEventListener("abort", abort);
        resolve(client);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
