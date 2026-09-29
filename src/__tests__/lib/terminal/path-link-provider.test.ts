import type { ILink, Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { terminalPathLinkProvider } from "@/lib/terminal/path-link-provider";

it("links complete paths across wrapped terminal rows", () => {
  const rows = ["See docs/des", "ign/file.png", "plain text  "];
  const terminal = {
    cols: 12,
    buffer: {
      active: {
        length: rows.length,
        getLine: (row: number) => ({
          isWrapped: row === 1,
          translateToString: () => rows[row],
          getCell: (column: number) => ({ getWidth: () => 1, getChars: () => rows[row][column] }),
        }),
      },
    },
  } as unknown as Terminal;
  const provider = terminalPathLinkProvider(terminal, { activate: vi.fn() }, (paths) => paths);
  for (const row of [1, 2]) {
    let links: ILink[] | undefined;
    provider.provideLinks(row, (result) => {
      links = result;
    });
    expect(links).toHaveLength(1);
    expect(links?.[0]).toMatchObject({
      text: "docs/design/file.png",
      range: { start: { x: 5, y: 1 }, end: { x: 12, y: 2 } },
    });
  }
  const callback = vi.fn();
  provider.provideLinks(3, callback);
  expect(callback).toHaveBeenCalledWith([]);
});

function fixture() {
  const rows = ["token/DPP docs/real.md docs/folder"];
  const terminal = {
    cols: 80,
    rows: 1,
    buffer: {
      active: {
        length: 1,
        viewportY: 0,
        getLine: (row: number) => ({
          isWrapped: false,
          translateToString: () => rows[row],
          getCell: (col: number) => ({
            getWidth: () => 1,
            getChars: () => rows[row]?.[col] ?? " ",
          }),
        }),
      },
    },
  } as unknown as Terminal;
  return { rows, terminal };
}

it("exposes only workspace-confirmed files and directories, not slash-separated prose", async () => {
  const { terminal } = fixture();
  const validate = vi.fn(async () => ["docs/real.md", "docs/folder"]);
  const callback = vi.fn();
  terminalPathLinkProvider(terminal, { activate: vi.fn() }, validate).provideLinks(1, callback);
  await Promise.resolve();
  expect(validate).toHaveBeenCalledWith(["token/DPP", "docs/real.md", "docs/folder"]);
  expect(callback.mock.calls[0][0].map((link: ILink) => link.text)).toEqual([
    "docs/real.md",
    "docs/folder",
  ]);
});

it("fails closed when validation is missing or unavailable", async () => {
  const { terminal } = fixture();
  for (const validate of [
    undefined,
    async () => {
      throw new Error("offline");
    },
  ]) {
    const callback = vi.fn();
    terminalPathLinkProvider(terminal, { activate: vi.fn() }, validate).provideLinks(1, callback);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledWith([]);
  }
});

it("discards validation results after the terminal row changes", async () => {
  const { terminal, rows } = fixture();
  let resolve!: (paths: string[]) => void;
  const callback = vi.fn();
  terminalPathLinkProvider(
    terminal,
    { activate: vi.fn() },
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  ).provideLinks(1, callback);
  rows[0] = "replacement text";
  resolve(["docs/real.md"]);
  await Promise.resolve();
  expect(callback).toHaveBeenCalledWith([]);
});

it.each([
  "resolve",
  "reject",
])("ignores superseded provider requests that %s after a newer row", async (outcome) => {
  const { terminal, rows } = fixture();
  rows.push("docs/new.md");
  Object.assign(terminal.buffer.active, { length: 2 });
  const requests: { resolve: (paths: string[]) => void; reject: (reason: Error) => void }[] = [];
  const provider = terminalPathLinkProvider(
    terminal,
    { activate: vi.fn() },
    () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  );
  const oldCallback = vi.fn();
  const currentCallback = vi.fn();
  provider.provideLinks(1, oldCallback);
  provider.provideLinks(2, currentCallback);
  requests[1].resolve(["docs/new.md"]);
  await Promise.resolve();
  expect(currentCallback.mock.calls[0][0][0].text).toBe("docs/new.md");
  if (outcome === "resolve") requests[0].resolve(["docs/real.md"]);
  else requests[0].reject(new Error("offline"));
  await Promise.resolve();
  expect(oldCallback).not.toHaveBeenCalled();
});

it("validates more than 128 candidates in bounded batches", async () => {
  const { terminal, rows } = fixture();
  const candidates = Array.from({ length: 260 }, (_, i) => `docs/file${i}.md`);
  rows[0] = candidates.join(" ");
  Object.assign(terminal, { cols: rows[0].length });
  const validate = vi.fn(async (paths: string[]) => {
    expect(paths.length).toBeLessThanOrEqual(128);
    return paths;
  });
  const callback = vi.fn();
  terminalPathLinkProvider(terminal, { activate: vi.fn() }, validate).provideLinks(1, callback);
  await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());
  expect(validate.mock.calls.map(([paths]) => paths.length)).toEqual([128, 128, 4]);
  expect(callback.mock.calls[0][0].map((link: ILink) => link.text)).toEqual(candidates);
});
