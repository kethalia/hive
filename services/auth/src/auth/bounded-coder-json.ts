import { ROTATION_LIMITS } from "./rotation-contracts";

/** Bounds both bytes and stalled reads, including injected Fetch implementations. */
export async function boundedCoderJson(response: Response, signal: AbortSignal) {
  if (!response.body) throw new Error("coder_response_invalid");
  const reader = response.body.getReader();
  let finished = false;
  let abort: (() => void) | undefined;
  try {
    const read = async () => {
      const parts: Uint8Array[] = [];
      let size = 0;
      for (let chunks = 0; chunks < 128; chunks++) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) {
          finished = true;
          const all = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            all.set(part, offset);
            offset += part.byteLength;
          }
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
        }
        size += next.value.byteLength;
        if (size > ROTATION_LIMITS.providerBytes) throw new Error("coder_response_limit");
        parts.push(next.value);
      }
      throw new Error("coder_response_limit");
    };
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("coder_response_deadline"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return await Promise.race([read(), interrupted]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (!finished)
      await Promise.race([
        reader.cancel().catch(() => {}),
        new Promise((done) => setTimeout(done, 100)),
      ]);
  }
}
