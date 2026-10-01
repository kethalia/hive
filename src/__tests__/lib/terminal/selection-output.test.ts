import { expect, it, vi } from "vitest";
import { createSelectionOutput } from "@/lib/terminal/selection-output";

it("holds updates while selecting and resumes all chunks in order after dismissal", () => {
  let selected = true;
  const write = vi.fn();
  const output = createSelectionOutput(() => selected, write, vi.fn());
  output.push("first");
  const bytes = new Uint8Array([65, 66]);
  output.push(bytes);
  output.flush();
  expect(write).not.toHaveBeenCalled();
  selected = false;
  output.flush();
  output.push("third");
  expect(write.mock.calls).toEqual([["first"], [bytes], ["third"]]);
});

it("bounds retained output and clears pending data on disposal", () => {
  let selected = true;
  const write = vi.fn();
  const release = vi.fn(() => {
    selected = false;
  });
  const output = createSelectionOutput(() => selected, write, release);
  const data = new Uint8Array(4 * 1024 * 1024 + 1);
  output.push(data);
  expect(release).toHaveBeenCalledOnce();
  expect(write.mock.calls[0]?.[0]).toBe(data);
  selected = true;
  output.push("discard");
  output.clear();
  selected = false;
  output.flush();
  expect(write).toHaveBeenCalledTimes(1);
});
