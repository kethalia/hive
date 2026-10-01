/** Hold output while native selection owns the DOM; resume in arrival order. */
export function createSelectionOutput(
  selected: () => boolean,
  write: (data: string | Uint8Array) => void,
  release: () => void,
) {
  let pending: (string | Uint8Array)[] = [];
  let bytes = 0;
  const flush = () => {
    if (selected()) return;
    const chunks = pending;
    pending = [];
    bytes = 0;
    for (const chunk of chunks) write(chunk);
  };
  return {
    push(data: string | Uint8Array) {
      pending.push(data);
      bytes += typeof data === "string" ? data.length * 2 : data.byteLength;
      // Bound memory if a noisy process runs while selection is left open.
      if (bytes > 4 * 1024 * 1024) release();
      flush();
    },
    flush,
    clear() {
      pending = [];
      bytes = 0;
    },
  };
}
