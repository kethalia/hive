import { TemplatePublicationError } from "./publication-contracts";

export async function publicationAwait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new TemplatePublicationError("provider_deadline"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export async function publicationBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) throw new TemplatePublicationError("provider_unavailable");
  const declared = response.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await cancelPublicationBody(response);
    throw new TemplatePublicationError("provider_response_limit");
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
        if (bytes > maximum) throw new TemplatePublicationError("provider_response_limit");
        chunks.push(next.value);
      }
      throw new TemplatePublicationError("provider_response_limit");
    };
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new TemplatePublicationError("provider_deadline"));
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

export async function cancelPublicationBody(response: Response) {
  await Promise.race([
    response.body?.cancel().catch(() => {}),
    new Promise((done) => setTimeout(done, 100)),
  ]);
}

export async function publicationFetch(
  work: Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  let abort: (() => void) | undefined;
  void work.then(
    (response) => {
      if (signal.aborted) void cancelPublicationBody(response);
    },
    () => {},
  );
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new TemplatePublicationError("provider_deadline"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
