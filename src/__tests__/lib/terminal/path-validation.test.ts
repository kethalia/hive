import { afterEach, expect, it, vi } from "vitest";
import { createTerminalPathValidator } from "@/lib/terminal/path-validation";

afterEach(() => vi.useRealTimers());

it("shares overlapping plain-path and OSC checks and returns redraw results synchronously", async () => {
  let resolve!: (paths: string[]) => void;
  const remote = vi.fn(
    () =>
      new Promise<string[]>((done) => {
        resolve = done;
      }),
  );
  const validate = createTerminalPathValidator(remote);
  const plain = validate(["docs/reference.png", "missing.png"]);
  const osc = validate(["docs/reference.png"]);
  for (let i = 0; i < 20; i++) validate(["docs/reference.png"]);
  expect(remote).toHaveBeenCalledTimes(1);
  resolve(["docs/reference.png"]);
  expect(await plain).toEqual(["docs/reference.png"]);
  expect(await osc).toEqual(["docs/reference.png"]);
  expect(validate(["docs/reference.png", "missing.png"])).toEqual(["docs/reference.png"]);
  expect(remote).toHaveBeenCalledTimes(1);
});

it("refreshes both existing and missing files after the short cache expires", async () => {
  vi.useFakeTimers();
  const remote = vi.fn().mockResolvedValueOnce(["old.png"]).mockResolvedValueOnce(["new.png"]);
  const validate = createTerminalPathValidator(remote);
  expect(await validate(["old.png", "new.png"])).toEqual(["old.png"]);
  vi.advanceTimersByTime(2_001);
  expect(await validate(["old.png", "new.png"])).toEqual(["new.png"]);
  expect(remote).toHaveBeenCalledTimes(2);
});

it("fails closed on a failed check and can recover on the next refresh", async () => {
  vi.useFakeTimers();
  const remote = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(["a.png"]);
  const validate = createTerminalPathValidator(remote);
  expect(await validate(["a.png"])).toEqual([]);
  vi.advanceTimersByTime(2_001);
  expect(await validate(["a.png"])).toEqual(["a.png"]);
});

it("keeps large validation results intact while bounding batches and cached entries", () => {
  const remote = vi.fn((paths: string[]) => paths);
  const validate = createTerminalPathValidator(remote);
  const paths = Array.from({ length: 300 }, (_, index) => `docs/${index}.md`);
  expect(validate(paths)).toEqual(paths);
  expect(remote.mock.calls.every(([batch]) => batch.length <= 128)).toBe(true);
  remote.mockClear();
  expect(validate([paths[0]])).toEqual([paths[0]]);
  expect(remote).toHaveBeenCalledTimes(1);
});
