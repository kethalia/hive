import { TERMINAL_PATH_BATCH_SIZE, type TerminalPathValidator } from "./link-target";

/** Share checks between OSC links and plain paths, including xterm redraws. */
export function createTerminalPathValidator(
  validate: TerminalPathValidator,
): TerminalPathValidator {
  const cache = new Map<string, { exists: boolean; expires: number }>();
  const pending = new Map<string, Promise<boolean>>();
  const remember = (path: string, exists: boolean) => {
    cache.delete(path);
    cache.set(path, { exists, expires: Date.now() + 2_000 });
    const oldest = cache.keys().next().value;
    if (cache.size > 256 && oldest !== undefined) cache.delete(oldest);
  };

  return (paths) => {
    const unique = [...new Set(paths)];
    const results = new Map<string, boolean | Promise<boolean>>();
    const missing = unique.filter((path) => {
      const cached = cache.get(path);
      if (cached && cached.expires <= Date.now()) cache.delete(path);
      const known = pending.get(path) ?? cache.get(path)?.exists;
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
          const check = checked.then((existing) => {
            const exists = existing.has(path);
            pending.delete(path);
            remember(path, exists);
            return exists;
          });
          pending.set(path, check);
          results.set(path, check);
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
}
