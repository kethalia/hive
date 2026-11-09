export async function terminalBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) throw new Error("Terminal response unavailable");
  const declared = response.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await cancelTerminalBody(response);
    throw new Error("Terminal response limit reached");
  }
  const reader = response.body.getReader();
  let abort: (() => void) | undefined,
    finished = false;
  try {
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (let n = 0; n < 4096; n++) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) {
          finished = true;
          const value = new Uint8Array(bytes);
          let at = 0;
          for (const chunk of chunks) {
            value.set(chunk, at);
            at += chunk.byteLength;
          }
          return value;
        }
        bytes += next.value.byteLength;
        if (bytes > maximum) throw new Error("Terminal response limit reached");
        chunks.push(next.value);
      }
      throw new Error("Terminal response limit reached");
    };
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Terminal deadline reached"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (!finished)
      await Promise.race([
        reader.cancel().catch(() => {}),
        new Promise((done) => setTimeout(done, 100)),
      ]);
  }
}

export async function cancelTerminalBody(response: Response) {
  await Promise.race([
    response.body?.cancel().catch(() => {}),
    new Promise((done) => setTimeout(done, 100)),
  ]);
}

export async function terminalFetch(
  work: Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  let abort: (() => void) | undefined;
  void work.then(
    (response) => {
      if (signal.aborted) void cancelTerminalBody(response);
    },
    () => {},
  );
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Terminal deadline reached"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
