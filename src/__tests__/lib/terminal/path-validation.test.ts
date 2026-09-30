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

it("expires relative positives and negatives on directory-affecting activity, keeping absolute checks", async () => {
  const remote = vi
    .fn()
    .mockResolvedValueOnce(["old.png", "/home/coder/image.png"])
    .mockResolvedValueOnce(["new.png"]);
  const validate = createTerminalPathValidator(remote);
  await validate(["old.png", "new.png", "/home/coder/image.png"]);
  validate.invalidateRelativePaths();
  expect(validate(["/home/coder/image.png"])).toEqual(["/home/coder/image.png"]);
  expect(await validate(["old.png", "new.png"])).toEqual(["new.png"]);
  expect(remote).toHaveBeenCalledTimes(2);
});

it("discards old-directory pending results without overwriting the new check", async () => {
  let oldReply!: (paths: string[]) => void;
  let newReply!: (paths: string[]) => void;
  const remote = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string[]>((r) => {
          oldReply = r;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<string[]>((r) => {
          newReply = r;
        }),
    );
  const validate = createTerminalPathValidator(remote);
  const old = validate(["docs/image.png"]);
  validate.invalidateRelativePaths();
  expect(await old).toEqual([]);
  const current = validate(["docs/image.png"]);
  oldReply(["docs/image.png"]);
  await Promise.resolve();
  const duplicate = validate(["docs/image.png"]);
  expect(remote).toHaveBeenCalledTimes(2);
  newReply([]);
  expect(await current).toEqual([]);
  expect(await duplicate).toEqual([]);
  expect(validate(["docs/image.png"])).toEqual([]);
});

it("settles stalled checks, retries immediately, and ignores late timed-out responses", async () => {
  vi.useFakeTimers();
  let oldReply!: (paths: string[]) => void;
  let newReply!: (paths: string[]) => void;
  const remote = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string[]>((r) => {
          oldReply = r;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<string[]>((r) => {
          newReply = r;
        }),
    );
  const validate = createTerminalPathValidator(remote);
  const old = validate(["/home/coder/image.png"]);
  const shared = validate(["/home/coder/image.png"]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await old).toEqual([]);
  expect(await shared).toEqual([]);
  const retry = validate(["/home/coder/image.png"]);
  oldReply(["/home/coder/image.png"]);
  await vi.advanceTimersByTimeAsync(0);
  const duplicate = validate(["/home/coder/image.png"]);
  expect(remote).toHaveBeenCalledTimes(2);
  newReply([]);
  expect(await retry).toEqual([]);
  expect(await duplicate).toEqual([]);
  expect(validate(["/home/coder/image.png"])).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels outstanding checks and timers when the terminal is disposed", async () => {
  vi.useFakeTimers();
  const validate = createTerminalPathValidator(() => new Promise(() => {}));
  const result = validate(["docs/image.png", "/home/coder/image.png"]);
  validate.dispose();
  expect(await result).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
