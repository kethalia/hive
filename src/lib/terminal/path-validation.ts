import { TERMINAL_PATH_BATCH_SIZE, type TerminalPathValidator } from "./link-target";

export const TERMINAL_PATH_VALIDATION_TIMEOUT_MS = 10_000;

/** Share checks between OSC links and plain paths, including xterm redraws. */
export function createTerminalPathValidator(
  validate: TerminalPathValidator,
): TerminalPathValidator & {
  invalidateRelativePaths(): void;
  dispose(): void;
} {
  const cache = new Map<string, { exists: boolean; expires: number }>();
  const pending = new Map<string, { result: Promise<boolean>; cancel(): void }>();
  const isRelative = (path: string) => !path.startsWith("/") && !path.startsWith("~/");
  const remember = (path: string, exists: boolean) => {
    cache.delete(path);
    cache.set(path, { exists, expires: Date.now() + 2_000 });
    const oldest = cache.keys().next().value;
    if (cache.size > 256 && oldest !== undefined) cache.delete(oldest);
  };

  const check: TerminalPathValidator = (paths) => {
    const unique = [...new Set(paths)];
    const results = new Map<string, boolean | Promise<boolean>>();
    const missing = unique.filter((path) => {
      const cached = cache.get(path);
      if (cached && cached.expires <= Date.now()) cache.delete(path);
      const known = pending.get(path)?.result ?? cache.get(path)?.exists;
      if (known !== undefined) results.set(path, known);
      return known === undefined;
    });
    for (let offset = 0; offset < missing.length; offset += TERMINAL_PATH_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + TERMINAL_PATH_BATCH_SIZE);
      let result: ReturnType<TerminalPathValidator>;
      try {
        result = validate(batch);
      } catch {
        result = [];
      }
      if (Array.isArray(result)) {
        const existing = new Set(result);
        for (const path of batch) {
          remember(path, existing.has(path));
          results.set(path, existing.has(path));
        }
      } else {
        const checked = result.then(
          (existing) => new Set(existing),
          () => new Set<string>(),
        );
        for (const path of batch) {
          let finish!: (exists: boolean, cacheResult: boolean) => void;
          const value = new Promise<boolean>((resolve) => {
            let settled = false;
            const timer = setTimeout(
              () => finish(false, false),
              TERMINAL_PATH_VALIDATION_TIMEOUT_MS,
            );
            finish = (exists, cacheResult) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              pending.delete(path);
              if (cacheResult) remember(path, exists);
              resolve(exists);
            };
          });
          pending.set(path, { result: value, cancel: () => finish(false, false) });
          void checked.then((existing) => finish(existing.has(path), true));
          results.set(path, value);
        }
      }
    }
    // A synchronous cache hit lets xterm finish re-linking a repainted row
    // without starting another server action or waiting on another response.
    if (unique.every((path) => typeof results.get(path) === "boolean")) {
      return unique.filter((path) => results.get(path));
    }
    return Promise.all(unique.map(async (path) => ((await results.get(path)) ? path : null))).then(
      (existing) => existing.filter((path): path is string => path !== null),
    );
  };
  return Object.assign(check, {
    invalidateRelativePaths() {
      for (const path of cache.keys()) if (isRelative(path)) cache.delete(path);
      for (const [path, request] of pending) if (isRelative(path)) request.cancel();
    },
    dispose() {
      cache.clear();
      for (const request of pending.values()) request.cancel();
    },
  });
}
